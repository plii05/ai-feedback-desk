# Feedback Desk

[简体中文](README.md)

Feedback Desk helps product managers and product operations teams review a batch of public feedback, prioritize issues and publish a briefing backed by source links. The blue-gray demo uses 62 public Microsoft PowerToys issues.

## Run the demo

```bash
python3 -m http.server 4173 --directory dist
```

Open [http://localhost:4173](http://localhost:4173). Use the **中文 / EN** switch in the top bar. The interface, demo themes and exports support both languages. Source excerpts and imported analysis retain their original wording. Enter your own localized title, summary or recommendation in the language in which you want it to appear.

| Page | What you can do |
| --- | --- |
| Overview | Start at a workflow step; inspect volume, priorities, upcoming follow-ups and recent decisions. Click a product area or priority to narrow the queue. |
| Feedback review | Move themes through Pending, Confirmed, Deferred and Completed. Review evidence and AI merge candidates, split or merge themes, and record ownership, dates and notes. |
| Product briefing | Automatically include 3, 5 or 10 confirmed themes or check the ones you want. Export Markdown or export the full queue as CSV. |
| Model evaluation | Compare MiniLM and a character n-gram TF-IDF baseline. Inspect threshold sensitivity and false merges, and export human correction pairs as JSONL. |

The **Import feedback** menu previews raw CSV or JSON, analysis snapshots, and workspace backups. The CSV template uses `id,title,excerpt,date,url,area,likes,comments`. Only ID and title are required. Appending skips duplicates and keeps existing records on conflicting IDs. Reviews and briefing selections are stored in this browser. Use a JSON backup to move them to another browser. The demo includes two confirmed themes.

You can export source issues for model analysis. A returned analysis for the same set of issues can update the groups while keeping prior decisions and follow-up details for groups with unchanged membership. Changed groups return to Pending. The workspace holds up to 500 issues. The analysis script accepts up to 100 per run.

## Correction pairs and priority scoring

In the review queue, select **AI-suggested priority** to sort by a 0–100 attention score. The scoring card explains the contribution of issue frequency (up to 50 at five issues), GitHub `+1` reactions and comments (up to 30 from a capped log transform of `likes + 0.5 × comments`), and recency (up to 20 points with a 14-day half-life relative to the latest issue in the workspace). Missing counts contribute zero. The human priority has its own control.

The evaluation page exports one JSONL record per issue pair, with the latest human label. Merging themes yields `merge / human_override`. Splitting a pair that came from an AI grouping or declining a model suggestion yields `split / false_merge`. An ordinary split yields `split / human_override`. Join issue IDs to the source-issue JSON for text and URLs. Workspace backups include the underlying decision history.

## Reproduce the benchmark

The 62 issue snapshot was split by reference theme into 18 development issues and 44 test issues. The test set has 110 same-area pairs, 22 of which are labeled as matches. Each threshold was selected on development data. On the test set, MiniLM achieved **52.8% average precision** and **40.0% F1**, compared with **36.9%** and **36.1%** for TF-IDF. At the selected threshold MiniLM proposed 42 false merges. Reviewers can decline suggestions before they enter a briefing. This is a small, selected snapshot with single-reviewer labels. The threshold panel shows connected components from 0.40 through 0.95 on the same test issues. Its precision and recall are calculated from final within-cluster pairs.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/benchmark.py
```

The pinned MiniLM model download is roughly 22 MB. [Source issues](https://github.com/microsoft/PowerToys/issues) · [Evaluation notes in Chinese](docs/evaluation.md)

## Run generative analysis

Set an authorized `OPENAI_API_KEY` environment variable and use Node.js 20 or later. These commands compare a staged extract, group and cite workflow with a single-pass report, using the same model and input. OpenAI calls require available API access. The published benchmark above covers MiniLM and TF-IDF.

```bash
npm run analyze -- --mode structured --output structured.json
npm run analyze -- --mode baseline --output baseline.json
node scripts/compare.mjs baseline.json structured.json
```

Import the generated snapshot in the site. Use `--input` for a custom issues JSON file formatted like `dist/data/issues.json`. A run takes up to 100 feedback entries. The analysis checks that every issue occurs in exactly one theme and cited text matches the source.
