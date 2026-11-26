"""Evaluate two text-matching methods on the same labeled issue pairs."""
import argparse
from itertools import combinations
import json
from pathlib import Path
import urllib.request

import numpy as np
import onnxruntime as ort
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import average_precision_score, precision_recall_fscore_support
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
REVISION = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41'


def model_file(cache, name):
    path = cache / Path(name).name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(path.suffix + '.part')
        urllib.request.urlretrieve(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}', partial)
        partial.replace(path)
    return path


def embed(texts, cache):
    tokenizer = Tokenizer.from_file(str(model_file(cache, 'tokenizer.json')))
    tokenizer.enable_truncation(max_length=224)
    tokenizer.enable_padding()
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = 2
    session = ort.InferenceSession(
        str(model_file(cache, 'onnx/model_quint8_avx2.onnx')),
        sess_options=session_options,
        providers=['CPUExecutionProvider'],
    )
    vectors = []
    for offset in range(0, len(texts), 16):
        batch = tokenizer.encode_batch(texts[offset:offset + 16])
        inputs = {
            'input_ids': np.array([row.ids for row in batch], dtype=np.int64),
            'attention_mask': np.array([row.attention_mask for row in batch], dtype=np.int64),
            'token_type_ids': np.array([row.type_ids for row in batch], dtype=np.int64),
        }
        outputs = session.run(None, {item.name: inputs[item.name] for item in session.get_inputs()})
        mask = inputs['attention_mask'][..., None]
        averaged = (outputs[0] * mask).sum(axis=1) / mask.sum(axis=1)
        vectors.extend(averaged / np.maximum(np.linalg.norm(averaged, axis=1, keepdims=True), 1e-12))
    return np.array(vectors)


def metrics(y, scores, threshold):
    pred = scores >= threshold
    p, r, f1, _ = precision_recall_fscore_support(y, pred, average='binary', zero_division=0)
    return {
        'precision': round(float(p), 4),
        'recall': round(float(r), 4),
        'f1': round(float(f1), 4),
        'averagePrecision': round(float(average_precision_score(y, scores)), 4),
        'predictedPairs': int(pred.sum()),
        'falsePositives': int(np.logical_and(pred, ~y).sum()),
        'falseNegatives': int(np.logical_and(~pred, y).sum()),
    }


def threshold_sweep(test_indices, test_pairs, similarity):
    """Score connected components, including singleton test issues."""
    rows = []
    for integer_threshold in range(40, 96):
        threshold = integer_threshold / 100
        parent = {index: index for index in test_indices}

        def root(index):
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        for first, second, _ in test_pairs:
            if similarity[first, second] >= threshold:
                parent[root(second)] = root(first)
        roots = {index: root(index) for index in test_indices}
        correct = false = missed = 0
        for first, second, expected in test_pairs:
            predicted = roots[first] == roots[second]
            correct += int(predicted and expected)
            false += int(predicted and not expected)
            missed += int(not predicted and expected)
        rows.append({
            'threshold': threshold,
            'clusters': len(set(roots.values())),
            'precision': round(correct / (correct + false), 4) if correct + false else 0,
            'recall': round(correct / (correct + missed), 4) if correct + missed else 0,
            'falseMerges': false,
            'missedMatches': missed,
        })
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.models')
    args = parser.parse_args()
    issues = json.loads((ROOT / 'dist/data/issues.json').read_text())
    reference = json.loads((ROOT / 'eval/reference.json').read_text())
    labels = {str(identifier): group for group in reference for identifier in group['ids']}
    assert len(labels) == len(issues), 'Reference must cover the snapshot once.'
    texts = [f"{i['title']}\n{i['excerpt']}" for i in issues]
    dev_indices = [index for index, issue in enumerate(issues) if labels[issue['id']]['split'] == 'dev']
    test_indices = [index for index, issue in enumerate(issues) if labels[issue['id']]['split'] == 'test']
    tfidf = TfidfVectorizer(analyzer='char_wb', ngram_range=(3, 5), sublinear_tf=True)
    tfidf.fit([texts[index] for index in dev_indices])
    lexical = tfidf.transform(texts)
    embedded = embed(texts, args.cache)
    similarities = {
        'TF-IDF': (lexical @ lexical.T).toarray(),
        'MiniLM': embedded @ embedded.T,
    }

    pairs = {'dev': [], 'test': []}
    for first, second in combinations(range(len(issues)), 2):
        a, b = (labels[issues[ix]['id']] for ix in (first, second))
        if a['area'] == b['area'] and a['split'] == b['split']:
            pairs[a['split']].append((first, second, a['key'] == b['key']))
    answer = {
        'issues': len(issues),
        'devIssues': len(dev_indices),
        'testIssues': len(issues) - len(dev_indices),
        'pairs': {key: {'total': len(rows), 'positive': sum(row[2] for row in rows)} for key, rows in pairs.items()},
        'models': [],
        'examples': [],
        'thresholdSweep': threshold_sweep(test_indices, pairs['test'], similarities['MiniLM']),
    }
    for name, sim in similarities.items():
        dev_y = np.array([p[2] for p in pairs['dev']], dtype=bool)
        dev_scores = np.array([sim[i, j] for i, j, _ in pairs['dev']])
        # Choose the development F1 maximum; ties prefer the more conservative threshold.
        candidates = np.arange(0.05, 0.991, 0.01).round(2)
        threshold = max(candidates, key=lambda t: (metrics(dev_y, dev_scores, t)['f1'], t))
        test_y = np.array([p[2] for p in pairs['test']], dtype=bool)
        test_scores = np.array([sim[i, j] for i, j, _ in pairs['test']])
        answer['models'].append({'name': name, 'threshold': float(threshold), **metrics(test_y, test_scores, threshold)})
        if name == 'MiniLM':
            errors = [
                {'first': issues[i]['id'], 'second': issues[j]['id'], 'score': round(float(sim[i, j]), 3),
                 'kind': 'false_merge' if sim[i, j] >= threshold else 'missed_match'}
                for i, j, expected in pairs['test'] if (sim[i, j] >= threshold) != expected
            ]
            for kind in ('false_merge', 'missed_match'):
                distinct = sorted((item for item in errors if item['kind'] == kind), key=lambda row: row['score'], reverse=kind == 'false_merge')
                answer['examples'].extend(distinct[:2])
            ranked = []
            for i, j in combinations(range(len(issues)), 2):
                if issues[i]['area'] == issues[j]['area'] and sim[i, j] >= 0.40:
                    ranked.append({'first': issues[i]['id'], 'second': issues[j]['id'], 'score': round(float(sim[i, j]), 3)})
            ranked.sort(key=lambda entry: -entry['score'])
            (ROOT / 'dist/data/suggestions.json').write_text(json.dumps(ranked, indent=2) + '\n')
    (ROOT / 'dist/data/benchmark.json').write_text(json.dumps(answer, indent=2) + '\n')
    print(json.dumps(answer, indent=2))


if __name__ == '__main__':
    main()
