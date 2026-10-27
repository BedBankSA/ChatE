import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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

const body = JSON.parse(readFileSync(".tools/openrouter-models-raw.json", "utf8"));
const data = body.data || [];
const byId = new Map(data.map((model) => [model.id, model]));

console.log(`catalog=${data.length}`);
console.log(`sample_keys=${Object.keys(data[0] || {}).sort().join(",")}`);

const missing = WANTED.filter((id) => !byId.has(id));
const excludedPresent = EXCLUDED.filter((id) => byId.has(id));
console.log(`missing=${missing.join("|") || "none"}`);
console.log(`excluded_present=${excludedPresent.join("|") || "none"}`);

function pick(model) {
  return {
    id: model.id,
    name: model.name ?? null,
    description: model.description ?? null,
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
    default_parameters: model.default_parameters ?? null,
  };
}

const models = WANTED.filter((id) => byId.has(id)).map((id) => pick(byId.get(id)));
mkdirSync("src/server/models", { recursive: true });
writeFileSync(
  "src/server/models/openrouter-public-snapshot.json",
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

for (const model of models) {
  const pricing = model.pricing || {};
  const architecture = model.architecture || {};
  const description = String(model.description || "").replace(/\s+/g, " ").slice(0, 280);
  console.log("---");
  console.log(model.id);
  console.log(`name=${model.name}`);
  console.log(
    `ctx=${model.context_length} max_out=${model.top_provider?.max_completion_tokens ?? "null"}`,
  );
  console.log(
    `price prompt=${pricing.prompt} completion=${pricing.completion} request=${pricing.request}`,
  );
  console.log(
    `mod ${(architecture.input_modalities || []).join("+")} -> ${(architecture.output_modalities || []).join("+")}`,
  );
  console.log(`params ${(model.supported_parameters || []).join(",")}`);
  console.log(`reasoning ${JSON.stringify(model.reasoning)}`);
  console.log(`desc ${description}`);
}
