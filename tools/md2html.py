# -*- coding: utf-8 -*-
"""
Minimal Markdown -> print-ready HTML for PROJECTS-ROADMAP.md.

Handles only the subset the document actually uses: ATX headings, pipe tables,
unordered lists, horizontal rules, paragraphs, and inline bold / italic / code.
Chrome then turns the HTML into a PDF, so all the page geometry lives in the CSS
below rather than in this script.
"""
import html
import io
import re
import sys

SRC, OUT = sys.argv[1], sys.argv[2]

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }

:root {
  --ink:      #14171a;
  --muted:    #5b6570;
  --rule:     #d8dde2;
  --accent:   #1f4e79;
  --code-bg:  #f3f5f7;
}

* { box-sizing: border-box; }

body {
  font-family: "Georgia", "Cambria", serif;
  font-size: 10.2pt;
  line-height: 1.55;
  color: var(--ink);
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

h1 {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 23pt;
  line-height: 1.15;
  letter-spacing: -0.4pt;
  margin: 0 0 6pt;
  color: var(--accent);
}

h2 {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 14pt;
  letter-spacing: -0.2pt;
  margin: 22pt 0 8pt;
  padding-bottom: 4pt;
  border-bottom: 1.2pt solid var(--accent);
  color: var(--accent);
  break-after: avoid;
}

h3 {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 12pt;
  margin: 18pt 0 2pt;
  color: var(--ink);
  break-after: avoid;
}

h4 {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 10pt;
  text-transform: uppercase;
  letter-spacing: 0.6pt;
  color: var(--muted);
  margin: 12pt 0 4pt;
  break-after: avoid;
}

p { margin: 0 0 8pt; text-align: justify; hyphens: auto; }

/* The stack / difficulty line that follows each project heading. */
h3 + p > strong:first-child {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 9pt;
  font-weight: 600;
  color: var(--muted);
}

ul, ol { margin: 0 0 10pt; padding-left: 18pt; }
li { margin: 0 0 3.5pt; }
li::marker { color: var(--accent); font-weight: 600; }

/* Document metadata block under the title. */
p.meta {
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 9pt;
  line-height: 1.7;
  text-align: left;
  color: var(--muted);
  border-left: 2pt solid var(--accent);
  padding-left: 8pt;
  margin-bottom: 14pt;
}
p.meta strong { color: var(--ink); }

strong { font-weight: 700; }
em { font-style: italic; }

code {
  font-family: "Consolas", "SF Mono", monospace;
  font-size: 0.86em;
  background: var(--code-bg);
  border: 0.5pt solid var(--rule);
  border-radius: 2pt;
  padding: 0.5pt 3pt;
}

hr {
  border: 0;
  border-top: 0.6pt solid var(--rule);
  margin: 16pt 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-family: "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 8.6pt;
  margin: 4pt 0 12pt;
  break-inside: avoid;
}

th {
  text-align: left;
  font-weight: 600;
  font-size: 8pt;
  text-transform: uppercase;
  letter-spacing: 0.5pt;
  color: #fff;
  background: var(--accent);
  padding: 5pt 7pt;
}

td {
  padding: 5pt 7pt;
  border-bottom: 0.5pt solid var(--rule);
  vertical-align: top;
  line-height: 1.4;
}

tbody tr:nth-child(even) td { background: #fafbfc; }

/* Keep a project's heading, its stack line and its first list together. */
h3, h3 + p { break-inside: avoid; }
"""


ORDERED = r"\d+\.\s+"
MARKER = r"(?:[-*]|\d+\.)\s+"          # start of a list item, either kind


def inline(text):
    """Escape, then re-introduce the inline markup as tags.

    Code spans are lifted out to placeholders first so that emphasis spanning a
    code span still matches — `**JSDoc plus `checkJs`.**` is one bold run, not two
    fragments either side of a backtick.
    """
    spans = []

    def stash(m):
        spans.append(html.escape(m.group(1)))
        return "\x00%d\x00" % (len(spans) - 1)

    piece = re.sub(r"`([^`]*)`", stash, text)
    piece = html.escape(piece)
    piece = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", piece)
    piece = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<em>\1</em>", piece)
    return re.sub(r"\x00(\d+)\x00",
                  lambda m: "<code>%s</code>" % spans[int(m.group(1))], piece)


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


with io.open(SRC, encoding="utf-8") as fh:
    lines = fh.read().splitlines()

body, i = [], 0
while i < len(lines):
    line = lines[i]
    stripped = line.strip()

    if not stripped:
        i += 1
        continue

    # Horizontal rule
    if re.fullmatch(r"-{3,}", stripped):
        body.append("<hr>")
        i += 1
        continue

    # Heading
    m = re.match(r"(#{1,6})\s+(.*)", stripped)
    if m:
        level = len(m.group(1))
        body.append("<h%d>%s</h%d>" % (level, inline(m.group(2)), level))
        i += 1
        continue

    # Table: a pipe row followed by a separator row
    if (stripped.startswith("|") and i + 1 < len(lines)
            and re.fullmatch(r"\|[\s:|-]+\|", lines[i + 1].strip())):
        head = split_row(stripped)
        i += 2
        rows = []
        while i < len(lines) and lines[i].strip().startswith("|"):
            rows.append(split_row(lines[i].strip()))
            i += 1
        body.append("<table><thead><tr>%s</tr></thead><tbody>%s</tbody></table>" % (
            "".join("<th>%s</th>" % inline(c) for c in head),
            "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in r)
                    for r in rows),
        ))
        continue

    # List, ordered or unordered; items may wrap onto indented continuation lines
    if re.match(MARKER, stripped):
        tag = "ol" if re.match(ORDERED, stripped) else "ul"
        items = []
        while i < len(lines) and re.match(MARKER, lines[i].strip()):
            text = re.sub("^" + MARKER, "", lines[i].strip())
            i += 1
            while (i < len(lines) and lines[i].startswith("  ")
                   and lines[i].strip()
                   and not re.match(MARKER, lines[i].strip())):
                text += " " + lines[i].strip()
                i += 1
            items.append(text)
        body.append("<%s>%s</%s>" % (
            tag, "".join("<li>%s</li>" % inline(t) for t in items), tag))
        continue

    # Paragraph: consume until a blank line or a block-level marker
    para = [stripped]
    i += 1
    while i < len(lines):
        nxt = lines[i].strip()
        if (not nxt or nxt.startswith("|") or nxt.startswith("#")
                or re.fullmatch(r"-{3,}", nxt) or re.match(MARKER, nxt)):
            break
        para.append(nxt)
        i += 1

    # Consecutive "**Label:** value" lines are a metadata block: keep the line
    # breaks the source author put there instead of reflowing them into prose.
    if len(para) > 1 and all(re.match(r"\*\*[^*]+:\*\*", p) for p in para):
        body.append("<p class='meta'>%s</p>"
                    % "<br>".join(inline(p) for p in para))
    else:
        body.append("<p>%s</p>" % inline(" ".join(para)))

with io.open(OUT, "w", encoding="utf-8") as fh:
    fh.write(
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Projects Roadmap</title><style>%s</style></head><body>%s</body></html>"
        % (CSS, "\n".join(body))
    )

print("wrote %s (%d blocks)" % (OUT, len(body)))
