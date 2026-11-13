"""Write src/lib/__fixtures__/note-format.json from Living Memory's own note_format, so the TypeScript mirror
in src/lib/note.ts can be checked against it.

Usage: python scripts/gen_note_fixtures.py PATH/TO/agentic-living-memory
Bodies are stored formatted, so each case records format_body(raw) and what LM reads from that.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from core import note_format as nf  # noqa: E402

CASES = {
    'plain': 'The cache is rebuildable.',
    'full': '## Executive Summary\nShort summary.\n\n## Key Details\n* **Why:** speed\n\n## Resource Links\n* [[Other note]]\n\n'
            '## Action Items\n- [ ] first\n- [x] second\n  - [ ] nested\n* [X] star bullet\n\n> ℹ️ **Important Note:**\n> careful',
    'callout_ends_actions': '## 📌 Executive Summary\nS\n\n## 🟩 Action Items\n- [ ] one\n> **Important Note:** two\n- [ ] after callout',
    'custom_sections': 'Lead text.\n\n## Notes\n- [ ] not an action item\n\n## action items\n- [ ] real one\n\n## Later\n- [ ] not either',
    'fence_heading': '## 📌 Executive Summary\nS\n\n```md\n## Action Items\n- [ ] in a fence\n```\n\n## 🟩 Action Items\n- [ ] real',
    'empty_sections': '## 📌 Executive Summary\nS\n\n## 📝 Key Details\n* \n\n## 🗂️ Resource Links\n\n## 🟩 Action Items\n- [ ] ',
    'crlf_and_rules': '## 📌 Executive Summary\r\n\r\nSummary line.\r\n\r\n---\r\n\r\n## 📝 Key Details\r\n* a\r\n* b',
    'quote_not_callout': '## 📌 Executive Summary\nS\n\n> just a quote\n\n## 🟩 Action Items\n- [ ] x',
    'legacy_layout': '# 🎯 Cache\n\n## 📌 Executive Summary\nThe cache is rebuildable.\n\n---\n\n## 📝 Key Details\n* **Why:** speed\n\n'
                     '## 🗂️ Resource Links\n* [[Other note]]\n\n## 🟩 Action Items\n- [ ] rebuild\n\n> ℹ️ **Important Note:**\n> never edit by hand',
    'new_layout': 'The cache is rebuildable.\n\n> **Important:** never edit by hand\n> it is rebuilt on start\n\n## Details\n- **Why:** speed\n\n'
                  '## Links\n- [[Other note]]\n\n## Action items\n- [ ] rebuild',
    'callout_moves_up': 'Summary first.\n\n## Details\n- a\n\n> **Important:** read this\n\n## Links\n- [[x]]',
    'typed_sections': 'We use event IDs as the key.\n\n## Why\nReplays are safe.\n\n## Alternatives considered\n- Hash of the payload\n\n## Details\n- d',
    'callout_before_summary': '> **Important:** read this\n\nSummary after the callout.\n\n## Details\n- d',
    'starts_with_why': '## Why\nReplays are safe.\n\n## Details\n- d',
    'quote_starting_important': 'S\n\n> Important things happen here\n\n## Details\n- d',
}

out = []
for name, raw in CASES.items():
    body = nf.format_body(raw)
    out.append({'name': name, 'raw': raw, 'body': body, 'sections': nf.sections(body),
                'parts': [[key, heading, text] for key, heading, text in nf.parts(body)],
                'actions': [[done, text] for done, text in nf.action_items(body)]})
target = Path(__file__).resolve().parents[1] / 'src/lib/__fixtures__/note-format.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({'source': 'core/note_format.py', 'cases': out}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{len(out)} cases -> {target}')
