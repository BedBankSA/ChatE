import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const WANTED = [
  "google/gemma-4-31b-it:free",
  "recursive/flint-v1.0:free",
  "google/gemma-4-26b-a4b-it:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling:free",
  "thinkingmachines/inkling-small:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-embed-1b:free",
  "nvidia/nemotron-3.5-embed-8b:free",
  "liquid/lfm-2.5-embedding-350m:free",
  "nvidia/nemotron-3.5-rerank-8b:free",
  "baseten/mammoth-1:free",
  "baseten/elephant-1:free",
  "respan/span-01-lite:free",
  "nvidia/nemotron-3.5-content-safety:free",
  "fish-audio/s2.1-pro-free:free",
  "openrouter/free",
];

const EXCLUDED = [
  "nvidia/nemotron-3-embed-1b:free",
  "nvidia/llama-nemotron-embed-vl-1b-v2:free",
  "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
];

function readKey() {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("OPENROUTER_API_KEY=")) continue;
    let value = line.slice("OPENROUTER_API_KEY=".length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

function slim(model) {
  return {
    id: model.id,
    name: model.name ?? null,
    description: typeof model.description === "string" ? model.description : null,
    context_length: model.context_length ?? null,
    pricing: model.pricing ?? null,
    architecture: model.architecture ?? null,
    supported_parameters: model.supported_parameters ?? null,
    top_provider: model.top_provider
      ? {
          context_length: model.top_provider.context_length ?? null,
          max_completion_tokens: model.top_provider.max_completion_tokens ?? null,
          is_moderated: model.top_provider.is_moderated ?? null,
        }
      : null,
    per_request_limits: model.per_request_limits ?? null,
    expiration_date: model.expiration_date ?? null,
    reasoning: model.reasoning ?? null,
    knowledge: model.knowledge ?? null,
    extra_keys: Object.keys(model).sort(),
  };
}

const key = readKey();
if (!key) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(1);
}

const response = await fetch("https://openrouter.ai/api/v1/models", {
  headers: {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  },
});

console.log(`status=${response.status}`);
if (!response.ok) {
  console.error("models request failed");
  process.exit(1);
}

const body = await response.json();
const data = Array.isArray(body.data) ? body.data : [];
const byId = new Map(data.map((model) => [model.id, model]));
const models = WANTED.filter((id) => byId.has(id)).map((id) => slim(byId.get(id)));
const missing = WANTED.filter((id) => !byId.has(id));
const excludedPresent = EXCLUDED.filter((id) => byId.has(id));

const outPath = "src/server/models/openrouter-public-snapshot.json";
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      source: "https://openrouter.ai/api/v1/models",
      requestCount: 1,
      catalogSize: data.length,
      missing,
      excludedPresent,
      models,
    },
    null,
    2,
  ),
);

console.log(`catalog=${data.length} matched=${models.length} missing=${missing.join("|") || "none"}`);
for (const model of models) {
  const prompt = model.pricing?.prompt ?? "none";
  const completion = model.pricing?.completion ?? "none";
  const params = Array.isArray(model.supported_parameters)
    ? model.supported_parameters.join(",")
    : "none";
  console.log(`${model.id} prompt=${prompt} completion=${completion} params=${params}`);
}
