#!/usr/bin/env python3
"""Build a compact JSON index from the myawesome vault for the MCP Worker."""
import json, os, re

VAULT = "D:/myawesome/awesome"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "data.json")

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "note"

categories = []   # {name, slug, sub_lists: [names], count}
sub_lists = []   # {name, slug, category, resources: [urls]}
resources_lookup = {}  # slug -> count

# walk all notes
for fn in os.listdir(VAULT):
    if not fn.endswith(".md"):
        continue
    path = os.path.join(VAULT, fn)
    txt = open(path, encoding="utf-8", errors="replace").read()
    typ = ""
    url = ""
    parent = ""
    m = re.search(r"^type: (.+)$", txt, re.M)
    if m: typ = m.group(1).strip()
    m = re.search(r"^url: (.+)$", txt, re.M)
    if m: url = m.group(1).strip()
    m = re.search(r"^parent: (.+)$", txt, re.M)
    if m: parent = m.group(1).strip()
    name = fn[:-3]
    # count folded resources in ## Resources
    nres = 0
    rm = re.search(r"## Resources\n(.*?)(\n## |\Z)", txt, re.S)
    if rm:
        nres = len(re.findall(r"^- \[", rm.group(1), re.M))
    if typ == "category":
        categories.append({"name": name.replace("_", "").replace("-", " ").title(),
                           "slug": name.lstrip("_")})
    elif typ == "sub-list" or (typ == "resource" and parent):
        # sub-list or resource with a parent -> a sub-list node
        sub_lists.append({"name": name, "slug": name, "parent": parent,
                          "resources": nres, "url": url if url.startswith("http") else ""})
    else:
        # standalone resource node
        sub_lists.append({"name": name, "slug": name, "parent": "",
                          "resources": nres, "url": url if url.startswith("http") else ""})

data = {"categories": categories, "sub_lists": sub_lists,
        "meta": {"generated": "from D:/myawesome/awesome", "count": len(categories) + len(sub_lists)}}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
JS = os.path.join(os.path.dirname(OUT), "data.mjs")
with open(JS, "w", encoding="utf-8") as f:
    f.write("export default ")
    json.dump(data, f, ensure_ascii=False)
    f.write(";\n")
print(f"Wrote {JS}: {len(categories)} categories, {len(sub_lists)} sub-lists")
