/*
  Blog articles with admin CRUD.

  Storage is data/blog.json, written atomically like the rest of the store.
  Each post carries the fields a real article needs - title, slug, excerpt,
  meta description, cover image with an alt tag, author, tags, a published/
  draft flag, and a content `blocks` array where the admin can place headings,
  paragraphs, and images (each image keeps its own alt tag).

  Everything the editor submits is stored verbatim and escaped at render time
  in the browser, so the raw fields never become markup by themselves. The
  routes here only normalise and validate.
*/

import path from "node:path";
import fs from "node:fs";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { writeJsonAtomic, readJsonWithBackup } from "./atomicJson.js";
import { requireAdmin } from "./auth.js";

const dataDir = path.join(process.cwd(), "data");
export const BLOG_PATH = path.join(dataDir, "blog.json");

const EMPTY = { posts: [] };

const BLOCK_TYPES = ["heading", "paragraph", "image"];
const MAX = {
  title: 200,
  slug: 200,
  excerpt: 500,
  metaDescription: 320,
  author: 120,
  coverImage: 2000,
  coverAlt: 400,
  tags: 20,
  tagLength: 60,
  blocks: 300,
  headingText: 2000,
  paragraphText: 200000,
  imageSrc: 2000
};

export function normalizeStatus(status) {
  return status === "published" ? "published" : "draft";
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX.slug) || "";
}

function uniqueSlug(base, posts, ignoreId) {
  if (!base) return base;
  let slug = base;
  let n = 2;
  const taken = new Set(
    posts
      .filter(p => p.id !== ignoreId)
      .map(p => String(p.slug || "").toLowerCase())
  );
  while (taken.has(slug.toLowerCase())) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function cleanBlocks(blocks, baseSlug) {
  if (!Array.isArray(blocks)) return [];
  const out = [];

  for (const block of blocks) {
    const type = BLOCK_TYPES.includes(block && block.type) ? block.type : null;
    if (!type) continue;

    if (type === "heading") {
      const text = String(block.text || "").trim().slice(0, MAX.headingText);
      if (text) out.push({ type: "heading", text });
    } else if (type === "paragraph") {
      const text = String(block.text || "").trim().slice(0, MAX.paragraphText);
      if (text) out.push({ type: "paragraph", text });
    } else if (type === "image") {
      const src = String(block.src || "").trim().slice(0, MAX.imageSrc);
      const alt = String(block.alt || "").trim().slice(0, MAX.coverAlt);
      if (src) out.push({ type: "image", src, alt });
    }

    if (out.length >= MAX.blocks) break;
  }

  return out;
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const tag = String(raw || "").trim().toLowerCase().slice(0, MAX.tagLength);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX.tags) break;
  }
  return out;
}

function readPosts() {
  const data = readJsonWithBackup(BLOG_PATH, EMPTY);
  return Array.isArray(data.posts) ? data.posts : [];
}

function writePosts(posts) {
  writeJsonAtomic(BLOG_PATH, { posts });
}

function sortPosts(posts) {
  return [...posts].sort((a, b) =>
    String(b.publishedAt || b.createdAt || "").localeCompare(String(a.publishedAt || a.createdAt || ""))
  );
}

export function listAllPosts() {
  return sortPosts(readPosts());
}

export function listPublishedPosts() {
  return sortPosts(readPosts().filter(p => p.status === "published"));
}

export function getPostBySlug(slug) {
  const match = String(slug || "").toLowerCase();
  return readPosts().find(p => p.slug.toLowerCase() === match) || null;
}

export function getPostById(id) {
  return readPosts().find(p => p.id === id) || null;
}

function trimPostForList(post) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    coverImage: post.coverImage,
    coverAlt: post.coverAlt,
    author: post.author,
    tags: post.tags || [],
    publishedAt: post.publishedAt || "",
    updatedAt: post.updatedAt || ""
  };
}

export function createPost(input = {}) {
  const title = String(input.title || "").trim().slice(0, MAX.title);
  if (!title) return { ok: false, error: "Title is required" };

  const posts = readPosts();
  const slug = uniqueSlug(
    slugify(String(input.slug || "").trim() || title),
    posts,
    null
  );

  if (!slug) return { ok: false, error: "A valid slug is required" };

  const now = new Date().toISOString();
  const status = normalizeStatus(input.status);

  const post = {
    id: uuidv4(),
    slug,
    title,
    excerpt: String(input.excerpt || "").trim().slice(0, MAX.excerpt),
    metaDescription: String(input.metaDescription || "").trim().slice(0, MAX.metaDescription),
    coverImage: String(input.coverImage || "").trim().slice(0, MAX.coverImage),
    coverAlt: String(input.coverAlt || "").trim().slice(0, MAX.coverAlt),
    author: String(input.author || "Leadmoz").trim().slice(0, MAX.author) || "Leadmoz",
    tags: cleanTags(input.tags),
    status,
    blocks: cleanBlocks(input.blocks, slug),
    createdAt: now,
    updatedAt: now,
    publishedAt: status === "published" ? now : ""
  };

  posts.push(post);
  writePosts(posts);
  return { ok: true, post };
}

export function updatePost(id, input = {}) {
  const posts = readPosts();
  const index = posts.findIndex(p => p.id === id);
  if (index === -1) return { ok: false, error: "Post not found" };

  const existing = posts[index];
  const title = String(input.title ?? (existing.title || "")).trim().slice(0, MAX.title);
  if (!title) return { ok: false, error: "Title is required" };

  const slug = uniqueSlug(
    slugify(String(input.slug || "").trim() || title),
    posts,
    id
  );
  if (!slug) return { ok: false, error: "A valid slug is required" };

  const status = normalizeStatus(input.status ?? existing.status);
  const now = new Date().toISOString();

  posts[index] = {
    ...existing,
    // Rebuild known fields from the incoming payload so removed fields clear.
    slug,
    title,
    excerpt: String(input.excerpt ?? existing.excerpt ?? "").trim().slice(0, MAX.excerpt),
    metaDescription: String(input.metaDescription ?? existing.metaDescription ?? "").trim().slice(0, MAX.metaDescription),
    coverImage: String(input.coverImage ?? existing.coverImage ?? "").trim().slice(0, MAX.coverImage),
    coverAlt: String(input.coverAlt ?? existing.coverAlt ?? "").trim().slice(0, MAX.coverAlt),
    author: String(input.author ?? existing.author ?? "Leadmoz").trim().slice(0, MAX.author) || "Leadmoz",
    tags: cleanTags(input.tags ?? existing.tags),
    status,
    blocks: cleanBlocks(input.blocks ?? existing.blocks, slug),
    updatedAt: now,
    // The first publish stamps the date; un-publishing keeps it so a later
    // re-publish does not reset the ordering.
    publishedAt: status === "published"
      ? (existing.publishedAt || now)
      : existing.publishedAt || ""
  };

  writePosts(posts);
  return { ok: true, post: posts[index] };
}

export function deletePost(id) {
  const posts = readPosts();
  const next = posts.filter(p => p.id !== id);
  if (next.length === posts.length) return false;
  writePosts(next);
  return true;
}

/*
  Image uploads go to public/blog/img/<timestamp>-<random>.<ext>, served by the
  existing express.static(PUBLIC_DIR). SVG is deliberately excluded because
  serving user-uploaded SVG is an XSS risk.
*/
const IMAGE_EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

/*
  The global express.json middleware skips requests whose Content-Type is not
  application/json, so this route-level raw parser sees the untouched bytes of
  the uploaded file.
*/
const imageUploadParser = express.raw({
  type: () => true,
  limit: "7mb"
});

export function registerBlogRoutes(app, { publicDir = path.join(process.cwd(), "public") } = {}) {
  app.get("/api/blog", (req, res) => {
    res.json({ posts: listPublishedPosts().map(trimPostForList) });
  });

  app.get("/api/blog/:slug", (req, res) => {
    const post = getPostBySlug(req.params.slug);
    if (!post || post.status !== "published") return res.status(404).json({ error: "Article not found" });
    res.json({ post });
  });

  app.get("/api/admin/blog", requireAdmin, (req, res) => {
    res.json({ posts: listAllPosts() });
  });

  app.post("/api/admin/blog", requireAdmin, (req, res) => {
    const result = createPost(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, post: result.post });
  });

  app.put("/api/admin/blog/:id", requireAdmin, (req, res) => {
    const result = updatePost(req.params.id, req.body || {});
    if (!result.ok) return res.status(result.error === "Post not found" ? 404 : 400).json({ error: result.error });
    res.json({ ok: true, post: result.post });
  });

  app.delete("/api/admin/blog/:id", requireAdmin, (req, res) => {
    if (!deletePost(req.params.id)) return res.status(404).json({ error: "Post not found" });
    res.json({ ok: true });
  });

  app.post("/api/admin/blog/upload/image", requireAdmin, imageUploadParser, (req, res) => {
    const buffer = req.body;
    const mime = String(req.headers["content-type"] || "").toLowerCase().split(";")[0];
    const ext = IMAGE_EXT_BY_MIME[mime];

    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: "Empty upload" });
    }
    if (buffer.length > 6 * 1024 * 1024) {
      return res.status(413).json({ error: "Image must be under 6MB" });
    }
    if (!ext) {
      return res.status(415).json({ error: "Only JPG, PNG, WEBP and GIF are allowed" });
    }

    const imgDir = path.join(publicDir, "blog", "img");
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
    const filePath = path.join(imgDir, name);
    fs.writeFileSync(filePath, buffer);

    res.json({ ok: true, url: `/blog/img/${name}` });
  });
}