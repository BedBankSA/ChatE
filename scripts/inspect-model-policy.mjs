import { readFileSync, writeFileSync } from "node:fs";

const body = JSON.parse(readFileSync(".tools/openrouter-models-raw.json", "utf8"));
const data = body.data || [];
const wanted = new Set(
  JSON.parse(readFileSync("src/server/models/openrouter-public-snapshot.json", "utf8")).models.map(
    (model) => model.id,
  ),
);

const needles = ["embed", "rerank", "mammoth", "elephant", "span-01", "fish-audio", "inkling", "nemotron-3.5"];
const similar = data
  .filter((model) => needles.some((needle) => model.id.toLowerCase().includes(needle)))
  .map((model) => model.id);
writeFileSync(".tools/similar-ids.txt", similar.sort().join("\n"));

const lines = [];
for (const model of data) {
  if (!wanted.has(model.id)) continue;
  lines.push(`\n===== ${model.id} =====`);
  lines.push(`default_parameters=${JSON.stringify(model.default_parameters ?? null)}`);
  lines.push(`links=${JSON.stringify(model.links ?? null)}`);
  lines.push(`per_request_limits=${JSON.stringify(model.per_request_limits ?? null)}`);
  lines.push(`expiration=${model.expiration_date ?? "null"}`);
  lines.push(String(model.description ?? ""));
}
writeFileSync(".tools/model-policy.txt", lines.join("\n"));
console.log(`similar=${similar.length} policy_chars=${lines.join("\n").length}`);
