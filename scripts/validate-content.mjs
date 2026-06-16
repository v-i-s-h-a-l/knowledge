import { access, readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  loadArticles,
  publicRoot,
  readJson,
  rootDir,
  toPosix
} from "./lib/content-utils.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("uri", {
  type: "string",
  validate(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }
});

const articleSchema = await readJson(path.join(rootDir, "schemas", "article.schema.json"));
const artifactSchema = await readJson(path.join(rootDir, "schemas", "artifact.schema.json"));
const validateArticle = ajv.compile(articleSchema);
const validateArtifact = ajv.compile(artifactSchema);
const errors = [];

function report(message) {
  errors.push(message);
}

function formatAjvErrors(prefix, validator) {
  for (const error of validator.errors ?? []) {
    report(`${prefix}: ${error.instancePath || "/"} ${error.message}`);
  }
}

async function assertExists(filePath) {
  try {
    await access(filePath);
  } catch {
    report(`Missing generated file: ${toPosix(path.relative(rootDir, filePath))}`);
  }
}

function claimMarkers(articleBody) {
  const markers = new Set();
  const spans = articleBody.match(/<span[^>]*class="[^"]*claim-marker[^"]*"[^>]*>/g) ?? [];
  for (const span of spans) {
    const id = span.match(/id="(claim-[0-9]{3})"/)?.[1];
    if (id) markers.add(id);
  }
  return markers;
}

const articles = await loadArticles();

if (articles.length === 0) {
  report("No articles found under content/articles/<yyyy>/<slug>.");
}

for (const article of articles) {
  const prefix = `${article.year}/${article.slug}`;
  const expectedSource = `content/articles/${article.year}/${article.slug}/article.md`;
  const expectedAgent = `content/articles/${article.year}/${article.slug}/agent.md`;

  if (!validateArticle(article.articleFrontmatter)) {
    formatAjvErrors(`${prefix} article frontmatter`, validateArticle);
  }

  if (!validateArtifact(article.artifact)) {
    formatAjvErrors(`${prefix} artifact`, validateArtifact);
  }

  if (article.articleFrontmatter.slug !== article.slug) {
    report(`${prefix}: frontmatter slug does not match folder slug.`);
  }

  if (article.articleFrontmatter.id !== `article:${article.slug}`) {
    report(`${prefix}: frontmatter id must be article:${article.slug}.`);
  }

  if (article.articleFrontmatter.sourcePath !== expectedSource) {
    report(`${prefix}: frontmatter sourcePath must be ${expectedSource}.`);
  }

  if (article.artifact.slug !== article.slug) {
    report(`${prefix}: artifact slug does not match folder slug.`);
  }

  if (article.artifact.id !== article.articleFrontmatter.id) {
    report(`${prefix}: artifact id does not match article id.`);
  }

  if (article.artifact.sourcePath !== expectedSource) {
    report(`${prefix}: artifact sourcePath must be ${expectedSource}.`);
  }

  if (article.artifact.agentBriefPath !== expectedAgent) {
    report(`${prefix}: artifact agentBriefPath must be ${expectedAgent}.`);
  }

  if (article.artifact.contentHash !== article.contentHash) {
    report(`${prefix}: artifact contentHash is stale. Run npm run generate.`);
  }

  const markers = claimMarkers(article.articleBody);
  const artifactClaims = new Set(article.artifact.claims.map((claim) => claim.id));

  for (const claimId of artifactClaims) {
    if (!markers.has(claimId)) {
      report(`${prefix}: claim ${claimId} is missing a visible article marker.`);
    }
  }

  for (const marker of markers) {
    if (!artifactClaims.has(marker)) {
      report(`${prefix}: article marker ${marker} is not present in artifact claims.`);
    }
  }

  const sourceIds = new Set(article.artifact.sources.map((source) => source.id));
  for (const claim of article.artifact.claims) {
    for (const sourceId of claim.evidence) {
      if (!sourceIds.has(sourceId)) {
        report(`${prefix}: ${claim.id} references missing source ${sourceId}.`);
      }
    }
  }

  const tokenBudget = Number(article.agentFrontmatter.tokenBudget ?? 0);
  const estimatedTokens = Math.ceil(article.agentBody.trim().split(/\s+/).length * 1.35);
  if (tokenBudget > 0 && estimatedTokens > tokenBudget) {
    report(`${prefix}: agent.md estimate ${estimatedTokens} tokens exceeds budget ${tokenBudget}.`);
  }

  await assertExists(path.join(publicRoot, "agents", "articles", `${article.slug}.json`));
  await assertExists(path.join(publicRoot, "agents", "articles", `${article.slug}.md`));
}

await assertExists(path.join(publicRoot, "agents", "index.json"));
await assertExists(path.join(publicRoot, "agents", "index.jsonl"));
await assertExists(path.join(publicRoot, "graph", "nodes.json"));
await assertExists(path.join(publicRoot, "graph", "edges.json"));
await assertExists(path.join(publicRoot, "llms.txt"));

try {
  const index = await readJson(path.join(publicRoot, "agents", "index.json"));
  if (index.articles?.length !== articles.length) {
    report(`Agent index has ${index.articles?.length ?? 0} article(s); expected ${articles.length}.`);
  }

  const jsonl = await readFile(path.join(publicRoot, "agents", "index.jsonl"), "utf8");
  const lines = jsonl.trim().split("\n").filter(Boolean);
  if (lines.length !== articles.length) {
    report(`Agent JSONL has ${lines.length} line(s); expected ${articles.length}.`);
  }
  for (const line of lines) {
    JSON.parse(line);
  }
} catch (error) {
  report(`Generated agent index is invalid: ${error.message}`);
}

if (errors.length > 0) {
  console.error("Content validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${articles.length} article(s), generated agent feeds, and graph artifacts.`);
