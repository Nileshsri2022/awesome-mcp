// Cloudflare Worker MCP server for the sindresorhus/awesome list
// Uses a Durable Object to hold MCP server state across requests.
// Descriptions are fetched LIVE from the sindresorhus/awesome readme on demand
// (in-memory cached for a few minutes per DO; never stored permanently).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpError, ErrorCode, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import data from "./data.mjs";

const README_URL = "https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md";
const DESC_TTL_MS = 5 * 60 * 1000; // 5 min

// ---- helpers ----
const norm = (s) => String(s || "").toLowerCase().trim();

function matchSubLists(q) {
  const qn = norm(q);
  if (!qn) return [];
  return data.sub_lists.filter(s =>
    norm(s.name).includes(qn) || norm(s.url).includes(qn) || norm(s.parent).includes(qn)
  );
}

function getCategory(name) {
  const s = norm(name).replace(/\s+/g, "-");
  const cat = data.categories.find(c => c.slug.startsWith(s) || norm(c.name).includes(norm(name)));
  if (!cat) return null;
  const kids = data.sub_lists.filter(s => norm(s.parent).includes(cat.slug));
  return { name: cat.name, slug: cat.slug, sub_lists: kids.map(k => k.name) };
}

// ---- live description loader ----
// Keyed by the repo path (e.g. "sindresorhus/awesome-nodejs"), which both the
// readme entries and our data urls share.
function repoPath(url) {
  const m = String(url || "").match(/github\.com\/([^/#?]+\/[^/#?]+)/);
  return m ? norm(m[1]).replace(/\.git$/, "") : "";
}

class DescLoader {
  constructor() {
    this.cache = null;      // Map: normalized repo path -> description
    this.cachedAt = 0;
  }

  async get() {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < DESC_TTL_MS) return this.cache;
    try {
      const res = await fetch(README_URL, { cf: { cacheTtl: 300 } });
      if (!res.ok) { if (this.cache) return this.cache; return new Map(); }
      const text = await res.text();
      const desc = new Map();
      for (const line of text.split("\n")) {
        const m = line.match(/^(\s*)- \[([^\]]+)\]\(([^)]+)\)\s*-\s*(.+)$/);
        if (m) {
          const rp = repoPath(m[3]);
          if (rp) desc.set(rp, m[4].trim());
        }
      }
      this.cache = desc;
      this.cachedAt = now;
      return desc;
    } catch (e) {
      return this.cache || new Map();
    }
  }

  async enrich(items) {
    const desc = await this.get();
    return items.map(it => {
      const d = desc.get(repoPath(it.url)) || "";
      return { ...it, description: d };
    });
  }
}

// ---- tool definitions ----
const TOOLS = [
  { name: "list_categories", description: "List all categories. Optional 'query' filters sub-lists (supports * wildcard, e.g. 'awesome-*').",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional filter pattern, e.g. 'awesome-*' or 'python'." } } } },
  { name: "get_category", description: "Get the sub-lists (with descriptions) for a category by name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Category name, e.g. 'Front-End Development'" } }, required: ["name"] } },
  { name: "search_resources", description: "Search resources by keyword against name, url, category, AND live description.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_sub_list", description: "Get details (with live description) about one sub-list by name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "top_resources_by_category", description: "Rank categories by sub-list count, with live descriptions.",
    inputSchema: { type: "object", properties: {} } },
  { name: "random_resource", description: "Return a random sub-list/resource with its live description.",
    inputSchema: { type: "object", properties: {} } },
];

// ---- tool handlers (async; receive descLoader) ----
function makeHandlers(loader) {
  return {
    list_categories: async (args) => {
      const q = (args && args.query) || "";
      if (!q) {
        return { content: [{ type: "text", text: JSON.stringify(data.categories.map(c => c.name)) }] };
      }
      // wildcard filter over sub-lists, then enrich with descriptions
      let re;
      try {
        re = new RegExp("^" + q.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
      } catch {
        re = new RegExp(norm(q), "i");
      }
      const matches = data.sub_lists.filter(s => re.test(norm(s.name))).slice(0, 100);
      return { content: [{ type: "text", text: JSON.stringify(await loader.enrich(matches.map(m => ({ name: m.name, url: m.url })))) }] };
    },
    get_category: async (args) => {
      const cat = getCategory(args.name);
      if (!cat) throw new McpError(ErrorCode.InvalidParams, `Unknown category: ${args.name}`);
      const kids = data.sub_lists.filter(s => norm(s.parent).includes(cat.slug));
      const enriched = await loader.enrich(kids.map(k => ({ name: k.name, url: k.url })));
      cat.sub_lists = enriched;
      return { content: [{ type: "text", text: JSON.stringify(cat) }] };
    },
    search_resources: async (args) => {
      const qn = norm(args.query);
      if (!qn) throw new McpError(ErrorCode.InvalidParams, "query required");
      const base = data.sub_lists.filter(s => norm(s.name).includes(qn) || norm(s.url).includes(qn) || norm(s.parent).includes(qn));
      // also match against live descriptions
      let hits = [...base];
      if (hits.length < 30) {
        const desc = await loader.get();
        const extra = data.sub_lists.filter(s => {
          const d = desc.get(repoPath(s.url)) || "";
          return d.includes(qn);
        });
        for (const e of extra) if (!hits.includes(e)) hits.push(e);
      }
      const enriched = await loader.enrich(hits.slice(0, 30).map(h => ({ name: h.name, url: h.url })));
      return { content: [{ type: "text", text: JSON.stringify(enriched) }] };
    },
    get_sub_list: async (args) => {
      const hit = data.sub_lists.find(s => norm(s.name) === norm(args.name)) || matchSubLists(args.name)[0];
      if (!hit) throw new McpError(ErrorCode.InvalidParams, `Unknown sub-list: ${args.name}`);
      const enriched = (await loader.enrich([{ name: hit.name, url: hit.url }]))[0];
      return { content: [{ type: "text", text: JSON.stringify({ ...hit, description: enriched.description }) }] };
    },
    top_resources_by_category: async () => {
      const counts = data.categories.map(c => ({ name: c.name, count: data.sub_lists.filter(s => norm(s.parent).includes(c.slug)).length }));
      counts.sort((a, b) => b.count - a.count);
      const enriched = await loader.enrich(counts);
      return { content: [{ type: "text", text: JSON.stringify(enriched) }] };
    },
    random_resource: async () => {
      const pick = data.sub_lists[Math.floor(Math.random() * data.sub_lists.length)];
      const enriched = (await loader.enrich([{ name: pick.name, url: pick.url }]))[0];
      return { content: [{ type: "text", text: JSON.stringify({ ...pick, description: enriched.description }) }] };
    },
  };
}

export class McpDo {
  constructor(state, env) {
    this.state = state;
    this.transport = null;
    this.server = null;
    this.loader = new DescLoader();
    this.handlers = null;
  }

  async ensureServer() {
    if (this.server) return;
    const server = new Server({ name: "awesome-mcp", version: "1.1.0" }, { capabilities: { tools: {} } });
    this.handlers = makeHandlers(this.loader);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const fn = this.handlers[req.params.name];
      if (!fn) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
      return fn(req.params.arguments || {});
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);
    this.server = server;
    this.transport = transport;
  }

  async fetch(request) {
    await this.ensureServer();
    return this.transport.handleRequest(request);
  }
}

export default {
  async fetch(request, env) {
    const id = env.MCP_DO.idFromName("v5");
    const stub = env.MCP_DO.get(id);
    return stub.fetch(request);
  },
};
