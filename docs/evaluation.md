# Model evaluation and product decisions

[简体中文](evaluation.zh-CN.md)

## Reference labels

Two issues can share a theme when they concern the same feature, a sufficiently similar trigger, and the same user-visible problem, so one verification step can address both. Broad reports or issues with distinguishable outcomes get separate themes. One reviewer labeled the issues using titles and public reports.

The PowerToys snapshot includes challenging non-matches from the same product area. Issues are split by reference theme into development and test sets, and each method compares issue pairs within the same area. The development set contains 26 pairs and 4 matches. The test set contains 110 pairs and 22 matches. TF-IDF fits its vocabulary on development data. Each method uses the threshold with the highest development F1, with ties resolved in favor of the higher threshold. Both methods use the same titles and excerpts.

## Test results

| Method | Threshold | Correct matches | False merges | Missed matches | Precision | Recall | F1 | Average precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Character n-gram TF-IDF | 0.26 | 15 | 46 | 7 | 24.6% | 68.2% | 36.1% | 36.9% |
| MiniLM | 0.50 | 16 | 42 | 6 | 27.6% | 72.7% | 40.0% | 52.8% |

Average precision summarizes the ranking of candidate pairs. Precision, recall, and F1 use the fixed thresholds in the table. The results describe this small, deliberately selected snapshot and its reference labels. Public issues represent only part of the user base.

## Sensitivity to the similarity threshold

For the 44 test issues, MiniLM connects same-area pairs that meet the threshold and forms themes from the resulting connected components. The cluster count includes singletons. Metrics include every pair in a final cluster, including connections formed indirectly through another issue. The test-results table above counts only direct predictions. The evaluation slider explores thresholds while the review queue uses the threshold selected on development data.

| Threshold | Clusters | Precision | Recall | False merges | Missed matches |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.65 | 26 | 32.6% | 63.6% | 29 | 8 |
| 0.75 | 38 | 88.9% | 36.4% | 1 | 14 |
| 0.85 | 43 | 100.0% | 4.5% | 0 | 21 |

At 0.85, the model grouped only one pair and that pair was correct. If a threshold predicts zero matches, precision is recorded as zero.

## Error examples and review controls

- **False merge at 0.773.** Both reports discuss PowerRename formatting. One concerns an altered file extension, while the other concerns an invalid path prefix being discarded. The review screen shows both reports and lets the reviewer keep the issues separate. [Issue #52209](https://github.com/microsoft/PowerToys/issues/52209) · [Issue #52208](https://github.com/microsoft/PowerToys/issues/52208)
- **Missed match at 0.059.** The English and Chinese reports both describe a failure to generate a new pairing key. English-language MiniLM assigned low similarity to this cross-language pair. The labeled demo theme retains both reports. Reviewers can search within the product area for related issues outside the candidate list. [Issue #51909](https://github.com/microsoft/PowerToys/issues/51909) · [Issue #51878](https://github.com/microsoft/PowerToys/issues/51878)

## Evaluating generative analysis

With API access, use the same inputs, model, and reference themes for single-pass and staged analysis. `compare.mjs` reports pairwise grouping quality and the number of themes with a verbatim quotation on the test set. Both paths run the same quotation checks. The generative comparison also counts false merges across product areas.

Reviewers can record the fields below. The evidence support check requires reading the original issue and judging whether it supports the claim.

| Theme | Claim to verify | Issue ID | Sufficient evidence | Reviewer edit | Time (seconds) |
| --- | --- | --- | --- | --- | --- |
| Example | Settings fails to open from the tray | 52049 | Yes | None | |

Reviewer edits include rewriting a summary, splitting or merging a theme, or changing priority. One edit can affect multiple pair labels, so intervention counts and pairwise errors are reported separately. Live generative evaluation results require a run with an API key.
