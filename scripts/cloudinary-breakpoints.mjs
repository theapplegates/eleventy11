#!/usr/bin/env node
/**
 * Upload an image to Cloudinary, request responsive breakpoints, merge the
 * resulting widths into src/data/cloudinary-breakpoints.json, and print a
 * ready-to-paste Eleventy shortcode plus a custom-element alternative.
 *
 * Usage:
 *   npm run cloudinary:breakpoints -- src/assets/images/my-photo.jpg
 *   npm run cloudinary:breakpoints -- src/assets/images/my-photo.jpg --sizes="100vw"
 *
 * With no --devices / --sizes flag the script shows device checkboxes
 * (Desktop / Laptop / Tablet / Phone) and emits an art-direction `devices`
 * string (per-device crops + a derived `sizes`). Press Enter to include all,
 * or type a custom sizes string for simple responsive mode. --devices="..." or
 * --sizes="..." skips the prompt. In a non-interactive shell all devices are
 * used. These only affect the printed snippet, not the upload.
 *
 * The Cloudinary public ID is derived from the file path by dropping the
 * leading "src/" segment and the file extension, e.g.
 *   src/assets/images/my-photo.jpg -> assets/images/my-photo
 *
 * Credentials are read from .env via Node's --env-file-if-exists flag (see
 * package.json), or from the surrounding process environment. The build does
 * NOT need the API key/secret -- only this upload script does.
 */
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const require = createRequire(import.meta.url);
const cloudinary = require("cloudinary").v2;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BREAKPOINTS_FILE = resolve(ROOT, "src/data/cloudinary-breakpoints.json");

const DEVICE_PRESETS = [
  { key: "desktop", label: "Desktop  >1200px",  minWidth: 1200, vw: 40,  aspectRatio: "original" },
  { key: "laptop",  label: "Laptop   992-1199", minWidth: 992,  vw: 60,  aspectRatio: "16:9" },
  { key: "tablet",  label: "Tablet   768-991",  minWidth: 768,  vw: 70,  aspectRatio: "4:3" },
  { key: "phone",   label: "Phone    <768",     minWidth: 0,    vw: 100, aspectRatio: "1:1" },
];

function parseArgs(argv) {
  let filePath = null;
  let sizesArg = null;
  let devicesArg = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--") continue;
    if (arg.startsWith("--sizes=")) {
      sizesArg = arg.slice("--sizes=".length);
    } else if (arg.startsWith("--devices=")) {
      devicesArg = arg.slice("--devices=".length);
    } else if (!filePath) {
      filePath = arg;
    }
  }
  return { filePath, sizesArg, devicesArg };
}

function buildSizes(selected) {
  const sorted = [...selected].sort((a, b) => a.minWidth - b.minWidth);
  const smallest = sorted[0];
  const rest = sorted.slice(1).sort((a, b) => b.minWidth - a.minWidth);
  const clauses = rest.map((d) => `(min-width: ${d.minWidth}px) ${d.vw}vw`);
  return [...clauses, `${smallest.vw}vw`].join(", ");
}

function buildDevicesString(selected) {
  return selected.map((d) => `${d.minWidth}|${d.vw}|${d.aspectRatio}`).join(",");
}

function parseDevicesString(input) {
  return input
    .split(",")
    .map((part) => {
      const seg = part.trim().split("|");
      return {
        minWidth: Number(seg[0]),
        vw: Number(seg[1]),
        aspectRatio: (seg[2] ?? "").trim() || "original",
      };
    })
    .filter(
      (d) =>
        Number.isFinite(d.minWidth) &&
        d.minWidth >= 0 &&
        Number.isFinite(d.vw) &&
        d.vw > 0
    );
}

async function chooseDevices(sizesArg, devicesArg) {
  if (devicesArg) {
    const parsed = parseDevicesString(devicesArg);
    if (parsed.length > 0) return { mode: "art", devices: parsed };
  }
  if (sizesArg) return { mode: "sizes", sizes: sizesArg };

  console.log("\nArt direction (check the device ranges to include):");
  DEVICE_PRESETS.forEach((d, i) => {
    console.log(`  [x] ${i + 1}) ${d.label}   ${d.aspectRatio}   ${d.vw}vw`);
  });

  if (!stdin.isTTY) return { mode: "art", devices: DEVICE_PRESETS };

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    answer = await rl.question(
      "Enter numbers to include, comma-separated (Enter = all, or type a custom sizes): "
    );
  } finally {
    rl.close();
  }
  const trimmed = answer.trim();
  if (!trimmed) return { mode: "art", devices: DEVICE_PRESETS };

  const nums = trimmed
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (nums.length > 0 && nums.every((n) => /^\d+$/.test(n))) {
    const selected = [];
    for (const n of nums) {
      const idx = Number(n) - 1;
      if (idx >= 0 && idx < DEVICE_PRESETS.length) {
        const d = DEVICE_PRESETS[idx];
        if (!selected.includes(d)) selected.push(d);
      }
    }
    if (selected.length > 0) return { mode: "art", devices: selected };
  }
  return { mode: "sizes", sizes: trimmed };
}

function derivePublicId(filePath) {
  const rel = relative(ROOT, resolve(ROOT, filePath)).replace(/\\/g, "/");
  const withoutSrc = rel.startsWith("src/") ? rel.slice(4) : rel;
  const ext = extname(withoutSrc);
  return ext ? withoutSrc.slice(0, -ext.length) : withoutSrc;
}

async function readBreakpoints() {
  if (!existsSync(BREAKPOINTS_FILE)) return {};
  try {
    return JSON.parse(await readFile(BREAKPOINTS_FILE, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${BREAKPOINTS_FILE}: ${err.message}`);
  }
}

async function writeBreakpoints(data) {
  await mkdir(dirname(BREAKPOINTS_FILE), { recursive: true });
  await writeFile(BREAKPOINTS_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main() {
  const { filePath, sizesArg, devicesArg } = parseArgs(process.argv);
  if (!filePath) {
    console.error(
      "Usage: npm run cloudinary:breakpoints -- <path-to-image> [--devices=\"...\"] [--sizes=\"...\"]"
    );
    process.exit(1);
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    console.error(
      "Missing Cloudinary credentials. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env."
    );
    process.exit(1);
  }

  const absPath = resolve(ROOT, filePath);
  if (!existsSync(absPath)) {
    console.error(`Image not found: ${absPath}`);
    process.exit(1);
  }

  const publicId = derivePublicId(filePath);

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });

  console.log(`Uploading "${absPath}" as public_id "${publicId}"...`);

  const result = await cloudinary.uploader.upload(absPath, {
    public_id: publicId,
    unique_filename: false,
    overwrite: true,
    resource_type: "image",
    responsive_breakpoints: [
      {
        create_derived: false,
        breakpoints: {
          min_width: 200,
          max_width: 2000,
          max_images: 10,
          auto_optimal_breakpoints: true,
        },
      },
    ],
  });

  const widths =
    result.responsive_breakpoints?.[0]?.breakpoints?.map((bp) => bp.width) ?? [];

  if (widths.length === 0) {
    console.error("Cloudinary returned no breakpoints. Full response:");
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const sorted = [...new Set(widths)].sort((a, b) => a - b);

  const data = await readBreakpoints();
  data[publicId] = sorted;
  await writeBreakpoints(data);

  console.log(
    `Wrote ${sorted.length} breakpoints for "${publicId}" to ${relative(ROOT, BREAKPOINTS_FILE)}`
  );
  console.log(sorted.join(", "));

  const intrinsicWidth = result.width;
  const intrinsicHeight = result.height;
  const choice = await chooseDevices(sizesArg, devicesArg);

  const baseOptions = {
    src: publicId,
    alt: "TODO: describe this image",
    width: intrinsicWidth,
    height: intrinsicHeight,
    breakpoints: sorted.join(", "),
    pictureClass: "responsive-picture",
  };

  if (choice.mode === "art") {
    baseOptions.devices = buildDevicesString(choice.devices);
  } else {
    baseOptions.sizes = choice.sizes;
  }

  const optionsJson = JSON.stringify(baseOptions);

  console.log("\nPaste ONE of these into your post (replace the alt text).");

  console.log("\n--- A) Shortcode (works in .md and .njk):\n");
  console.log(`{% cloudinaryPicture '${optionsJson}' %}`);

  console.log("\n--- B) Custom element (works in .njk / .html):\n");
  const htmlAttrs = Object.entries(baseOptions)
    .map(([key, value]) => {
      const attrName = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `  ${attrName}="${String(value).replace(/"/g, "&quot;")}"`;
    })
    .join("\n");
  console.log(`<cloudinary-picture\n${htmlAttrs}\n></cloudinary-picture>`);

  console.log("\n");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
