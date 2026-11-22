import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const blogModule = pathToFileURL(path.join(here, "..", "src", "blog.js")).href;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${name}`);
    console.log(`  ${err.message}`);
  }
}

/*
  blog.js resolves its data dir from process.cwd(), so each scenario runs in a
  throwaway directory and the real data/blog.json is never touched.
*/
function scenario(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leadmoz-blog-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });

  const script = `
    const blog = await import(${JSON.stringify(blogModule)});
    const out = await (async () => { ${body} })();
    console.log("__RESULT__" + JSON.stringify(out));
  `;

  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    encoding: "utf8"
  });

  const line = stdout.split("\n").find(l => l.startsWith("__RESULT__"));
  const value = line ? JSON.parse(line.slice("__RESULT__".length)) : null;
  const dbFile = path.join(dir, "data", "blog.json");
  const onDisk = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : null;
  fs.rmSync(dir, { recursive: true, force: true });

  return { value, db: onDisk };
}

const fullPost = {
  title: "  How to Find Plumbers in Austin  ",
  slug: "",
  excerpt: "A short card summary.",
  metaDescription: "Learn the exact steps to build a list of plumbing leads in Austin, verified with email and phone.",
  coverImage: "/blog/img/cover.jpg",
  coverAlt: "Austin skyline at sunset",
  author: "Abubakar",
  tags: ["Lead-Gen", " lead-gen ", "SEO", "", "Outreach"],
  status: "published",
  blocks: [
    { type: "heading", text: "Start with the map" },
    { type: "paragraph", text: "OpenStreetMap coverage is solid in mid-size metros." },
    { type: "image", src: "/blog/img/map.png", alt: "Map of plumbers in Austin" },
    { type: "heading", text: "   " },
    { type: "bogus", text: "should be dropped" },
    { type: "paragraph", text: "" }
  ]
};

check("creating a post validates the title", () => {
  const { value } = scenario(`
    const bad = blog.createPost({ title: "   " });
    return { badOk: bad.ok, badError: bad.error };
  `);
  assert.equal(value.badOk, false, "blank title should be rejected");
  assert.match(value.badError, /Title is required/);
});

check("creating a post generates a slug from the title", () => {
  const { value } = scenario(`
    const result = blog.createPost(${JSON.stringify(fullPost)});
    return { ok: result.ok, slug: result.post.slug };
  `);
  assert.equal(value.ok, true);
  assert.equal(value.slug, "how-to-find-plumbers-in-austin");
});

check("duplicate titles get unique slugs", () => {
  const { value } = scenario(`
    const first = blog.createPost(${JSON.stringify(fullPost)});
    const second = blog.createPost(${JSON.stringify(fullPost)});
    return { first: first.post.slug, second: second.post.slug };
  `);
  assert.equal(value.first, "how-to-find-plumbers-in-austin");
  assert.equal(value.second, "how-to-find-plumbers-in-austin-2");
});

check("tags are trimmed, deduped and lowercased", () => {
  const { value } = scenario(`
    const result = blog.createPost(${JSON.stringify(fullPost)});
    return { tags: result.post.tags };
  `);
  assert.deepEqual(value.tags, ["lead-gen", "seo", "outreach"]);
});

check("invalid and empty blocks are dropped, image alt kept", () => {
  const { value } = scenario(`
    const result = blog.createPost(${JSON.stringify(fullPost)});
    return { blocks: result.post.blocks };
  `);
  assert.deepEqual(value.blocks, [
    { type: "heading", text: "Start with the map" },
    { type: "paragraph", text: "OpenStreetMap coverage is solid in mid-size metros." },
    { type: "image", src: "/blog/img/map.png", alt: "Map of plumbers in Austin" }
  ]);
});

check("meta description, cover image and alt are stored verbatim", () => {
  const { value } = scenario(`
    const result = blog.createPost(${JSON.stringify(fullPost)});
    const post = blog.getPostBySlug("how-to-find-plumbers-in-austin");
    return {
      metaDescription: post.metaDescription,
      coverImage: post.coverImage,
      coverAlt: post.coverAlt,
      author: post.author,
      status: post.status,
      hasPublishedAt: Boolean(post.publishedAt)
    };
  `);
  assert.equal(value.metaDescription, fullPost.metaDescription);
  assert.equal(value.coverImage, "/blog/img/cover.jpg");
  assert.equal(value.coverAlt, "Austin skyline at sunset");
  assert.equal(value.author, "Abubakar");
  assert.equal(value.status, "published");
  assert.equal(value.hasPublishedAt, true);
});

check("drafts are hidden from the public list", () => {
  const { value } = scenario(`
    const draft = blog.createPost({ title: "Draft post", status: "draft" });
    const published = blog.createPost({ title: "Live post", status: "published" });
    return {
      all: blog.listAllPosts().map(p => p.status),
      public: blog.listPublishedPosts().map(p => p.slug)
    };
  `);
  assert.deepEqual(value.all, ["published", "draft"]);
  assert.deepEqual(value.public, ["live-post"]);
});

check("updating a post edits fields and keeps its publish date", () => {
  const { value } = scenario(`
    const created = blog.createPost({ title: "First title", status: "published", tags: ["seo"] });
    const updated = blog.updatePost(created.post.id, {
      title: "Second title",
      tags: ["outreach", "seo"],
      coverImage: "/blog/img/new.jpg"
    });
    const reloaded = blog.getPostBySlug("second-title");
    return {
      slug: updated.post.slug,
      title: reloaded.title,
      coverImage: reloaded.coverImage,
      tags: reloaded.tags,
      publishedAtKept: reloaded.publishedAt === created.post.publishedAt
    };
  `);
  assert.equal(value.slug, "second-title");
  assert.equal(value.title, "Second title");
  assert.equal(value.coverImage, "/blog/img/new.jpg");
  assert.deepEqual(value.tags, ["outreach", "seo"]);
  assert.equal(value.publishedAtKept, true);
});

check("un-publishing then re-publishing keeps the original date", () => {
  const { value } = scenario(`
    const created = blog.createPost({ title: "A story", status: "published" });
    const publishedAt = created.post.publishedAt;
    blog.updatePost(created.post.id, { title: "A story", status: "draft" });
    const republished = blog.updatePost(created.post.id, { title: "A story", status: "published" });
    return { same: republished.post.publishedAt === publishedAt };
  `);
  assert.equal(value.same, true);
});

check("deleting a post removes it from disk", () => {
  const { value } = scenario(`
    const created = blog.createPost({ title: "Gone soon", status: "draft" });
    const removed = blog.deletePost(created.post.id);
    const stillThere = blog.getPostById(created.post.id);
    const secondRemove = blog.deletePost(created.post.id);
    return { removed, stillThere: Boolean(stillThere), secondRemove };
  `);
  assert.equal(value.removed, true);
  assert.equal(value.stillThere, false);
  assert.equal(value.secondRemove, false);
});

check("slugify normalises punctuation and caps", () => {
  const { value } = scenario(`
    return {
      a: blog.slugify("  Find & Keep HVAC Clients! "),
      b: blog.slugify("Roofing"),
      c: blog.slugify("  ")
    };
  `);
  assert.deepEqual(value, { a: "find-and-keep-hvac-clients", b: "roofing", c: "" });
});

console.log(failures ? `\n${failures} test(s) failed` : "\nall blog tests passed");
process.exit(failures ? 1 : 0);