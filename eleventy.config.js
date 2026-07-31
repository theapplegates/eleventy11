/**
 * Most adjustments must be made in `./src/_config/*`
 *
 * Hint VS Code for eleventyConfig autocompletion.
 * © Henry Desroches - https://gist.github.com/xdesro/69583b25d281d055cd12b144381123bf
 * @param {import("@11ty/eleventy/src/UserConfig")} eleventyConfig -
 * @returns {Object} -
 */

// register dotenv for process.env.* variables to pickup
import dotenv from 'dotenv';
dotenv.config();

// add yaml support
import { load as yamlLoad } from 'js-yaml';

// node helpers for cloudinary picture shortcode
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

//  config import
import { getAllPosts, showInSitemap, tagList } from './src/_config/collections.js';
import events from './src/_config/events.js';
import filters from './src/_config/filters.js';
import plugins from './src/_config/plugins.js';
import shortcodes from './src/_config/shortcodes.js';

// cloudinary setup
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cloudinary = require('cloudinary').v2;

const BREAKPOINTS_FILE = resolve(__dirname, 'src/data/cloudinary-breakpoints.json');

if (!process.env.CLOUDINARY_CLOUD_NAME) {
  console.warn('[cloudinaryPicture] CLOUDINARY_CLOUD_NAME is not set.');
}

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '' });

const FORMAT_ORDER = ['jxl', 'avif', 'webp'];
const MIME_TYPES = {
  jxl: 'image/jxl',
  avif: 'image/avif',
  webp: 'image/webp',
};

// ---------------------------------------------------------------------------
// Cloudinary picture helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseOptions(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    let t = raw.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1).trim();
    }
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.parse(t);
      } catch (err) {
        throw new Error(`cloudinaryPicture options JSON is invalid: ${err.message}`);
      }
    }
  }
  return {};
}

function valueToAttribute(key, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  if (Array.isArray(value)) {
    if (key === 'devices') {
      return value
        .map((d) => `${d.minWidth ?? d.min_width}|${d.vw}|${d.aspectRatio ?? d.ratio ?? 'original'}`)
        .join(',');
    }
    return value.join(', ');
  }
  return undefined;
}

function optionsToCustomElementTag(opts) {
  const attrs = Object.entries(opts)
    .map(([key, value]) => {
      const attrValue = valueToAttribute(key, value);
      if (attrValue === undefined) return '';
      const attrName = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${attrName}="${attrValue.replace(/"/g, '&quot;')}"`;
    })
    .filter(Boolean)
    .join(' ');
  return `<cloudinary-picture ${attrs}></cloudinary-picture>`;
}

function toBreakpointList(input) {
  if (input === undefined || input === null || input === '') return undefined;
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        return JSON.parse(t);
      } catch {
        /* fall through */
      }
    }
    return t
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n));
  }
  if (input && typeof input === 'object' && Array.isArray(input.breakpoints)) {
    return input.breakpoints;
  }
  return undefined;
}

function toDeviceList(input) {
  if (input === undefined || input === null || input === '') return undefined;
  if (Array.isArray(input)) {
    return input
      .map((d) => ({
        minWidth: Number(d.minWidth ?? d.min_width),
        vw: Number(d.vw),
        aspectRatio: String(d.aspectRatio ?? d.ratio ?? 'original') || 'original',
      }))
      .filter(
        (d) =>
          Number.isFinite(d.minWidth) &&
          d.minWidth >= 0 &&
          Number.isFinite(d.vw) &&
          d.vw > 0
      );
  }
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        return toDeviceList(JSON.parse(t));
      } catch {
        /* fall through */
      }
    }
    return t
      .split(',')
      .map((part) => {
        const seg = part.trim().split('|');
        return {
          minWidth: Number(seg[0]),
          vw: Number(seg[1]),
          aspectRatio: (seg[2] ?? '').trim() || 'original',
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
  return undefined;
}

function ratioHeight(targetWidth, aspectRatio, sourceWidth, sourceHeight) {
  if (!aspectRatio || aspectRatio === 'original') {
    return Math.round((targetWidth * sourceHeight) / sourceWidth);
  }
  const match = String(aspectRatio).match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    return Math.round((targetWidth * Number(match[2])) / Number(match[1]));
  }
  return Math.round((targetWidth * sourceHeight) / sourceWidth);
}

function maxDeviceWidth(device, intrinsicWidth, intrinsicHeight) {
  if (!device.aspectRatio || device.aspectRatio === 'original') return intrinsicWidth;
  const match = String(device.aspectRatio).match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    return Math.min(
      intrinsicWidth,
      Math.round((intrinsicHeight * Number(match[1])) / Number(match[2]))
    );
  }
  return intrinsicWidth;
}

function deviceTransformations(device) {
  if (!device.aspectRatio || device.aspectRatio === 'original') {
    return { crop: 'limit' };
  }
  return {
    crop: 'fill',
    aspect_ratio: device.aspectRatio,
    gravity: 'auto',
  };
}

function buildSizesFromDevices(list) {
  const sorted = [...list].sort((a, b) => a.minWidth - b.minWidth);
  const smallest = sorted[0];
  const rest = sorted.slice(1).sort((a, b) => b.minWidth - a.minWidth);
  const clauses = rest.map((d) => `(min-width: ${d.minWidth}px) ${d.vw}vw`);
  return [...clauses, `${smallest.vw}vw`].join(', ');
}

function readBreakpoints() {
  if (!existsSync(BREAKPOINTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BREAKPOINTS_FILE, 'utf8'));
  } catch (err) {
    console.warn(`[cloudinaryPicture] Could not read ${BREAKPOINTS_FILE}: ${err.message}`);
    return {};
  }
}

function buildUrl(src, width, format, extraTransforms = {}) {
  return cloudinary.url(src, {
    secure: true,
    quality: 'auto',
    crop: 'limit',
    ...extraTransforms,
    width,
    format,
  });
}

function renderCloudinaryPicture(opts) {
  const {
    src,
    alt,
    width,
    height,
    sizes,
    devices,
    breakpoints,
    pictureClass,
    'picture-class': pictureClassKebab,
    loading = 'lazy',
    decoding = 'async',
    transformations = {},
  } = opts;

  if (!src) throw new Error('cloudinaryPicture requires a src.');
  if (!alt || String(alt).trim() === '') {
    throw new Error(`cloudinaryPicture requires a non-empty alt for src "${src}".`);
  }

  const intrinsicWidth = Number(width);
  const intrinsicHeight = Number(height);
  if (!Number.isFinite(intrinsicWidth) || !Number.isFinite(intrinsicHeight)) {
    throw new Error(`cloudinaryPicture requires numeric width/height for src "${src}".`);
  }

  let bpList =
    breakpoints !== undefined && breakpoints !== null
      ? toBreakpointList(breakpoints)
      : readBreakpoints()[src];

  if (!bpList || bpList.length === 0) {
    throw new Error(
      `Cloudinary breakpoints are missing for "${src}". Run "npm run cloudinary:breakpoints -- src/assets/images/<file>" and pass the widths.`
    );
  }

  const normalized = [
    ...new Set([...bpList, intrinsicWidth].filter((w) => Number.isFinite(w) && w > 0)),
  ].sort((a, b) => a - b);

  const finalBreakpoints = normalized.filter((w) => w <= intrinsicWidth);
  if (finalBreakpoints.length === 0) finalBreakpoints.push(intrinsicWidth);

  const deviceList = toDeviceList(devices);
  const hasDevices = deviceList && deviceList.length > 0;

  if (!hasDevices && (!sizes || String(sizes).trim() === '')) {
    throw new Error(`cloudinaryPicture for "${src}" needs either "sizes" or "devices".`);
  }

  const cls = pictureClass ?? pictureClassKebab;
  const pictureClassAttr = cls ? ` class="${escapeHtml(cls)}"` : '';
  const loadingAttr = loading ? ` loading="${escapeHtml(loading)}"` : '';
  const decodingAttr = decoding ? ` decoding="${escapeHtml(decoding)}"` : '';

  let sourcesHtml = '';
  let fallbackSrc;
  let fallbackWidth = intrinsicWidth;
  let fallbackHeight = intrinsicHeight;
  let sizesAttr = '';

  if (hasDevices) {
    const sortedAsc = [...deviceList].sort((a, b) => a.minWidth - b.minWidth);
    const smallest = sortedAsc[0];
    const sourceDevices = sortedAsc.slice(1).sort((a, b) => b.minWidth - a.minWidth);

    sizesAttr = escapeHtml(buildSizesFromDevices(deviceList));

    const sourceTags = sourceDevices.flatMap((device) =>
      FORMAT_ORDER.map((format) => {
        const cap = maxDeviceWidth(device, intrinsicWidth, intrinsicHeight);
        const widths = finalBreakpoints.filter((w) => w <= cap);
        const list = widths.length ? widths : [Math.min(intrinsicWidth, cap)];
        const srcset = list
          .map(
            (w) =>
              `${escapeHtml(buildUrl(src, w, format, deviceTransformations(device)))} ${w}w`
          )
          .join(', ');

        return `<source media="(min-width: ${device.minWidth}px)" type="${MIME_TYPES[format]}" sizes="${sizesAttr}" srcset="${srcset}">`;
      })
    );

    sourcesHtml = sourceTags.join('\n  ');

    fallbackWidth = Math.min(
      intrinsicWidth,
      maxDeviceWidth(smallest, intrinsicWidth, intrinsicHeight)
    );
    fallbackSrc = escapeHtml(buildUrl(src, fallbackWidth, 'webp', deviceTransformations(smallest)));
    fallbackHeight = ratioHeight(
      fallbackWidth,
      smallest.aspectRatio,
      intrinsicWidth,
      intrinsicHeight
    );
  } else {
    sizesAttr = escapeHtml(String(sizes));

    const sourceTags = FORMAT_ORDER.map((format) => {
      const srcset = finalBreakpoints
        .map((w) => `${escapeHtml(buildUrl(src, w, format, transformations))} ${w}w`)
        .join(', ');
      return `<source type="${MIME_TYPES[format]}" sizes="${sizesAttr}" srcset="${srcset}">`;
    });

    sourcesHtml = sourceTags.join('\n  ');
    fallbackSrc = escapeHtml(buildUrl(src, intrinsicWidth, 'webp', transformations));
  }

  return `<picture${pictureClassAttr}>
  ${sourcesHtml}
  <img src="${fallbackSrc}" alt="${escapeHtml(alt)}" width="${fallbackWidth}" height="${fallbackHeight}" sizes="${sizesAttr}"${loadingAttr}${decodingAttr}>
</picture>`;
}

function parseHtmlAttributes(attrString) {
  const attrs = {};
  const regex = /\b([\w:-]+)=(?:["']([^"']*)["']|(\S+))/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? '';
    const camel = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    attrs[camel] = value;
  }
  return attrs;
}

export default async function (eleventyConfig) {
  // --------------------- Events: before build
  eleventyConfig.on('eleventy.before', async () => {
    await events.buildAllCss();
    await events.buildAllJs();
  });

  // --------------------- custom wtach targets
  eleventyConfig.addWatchTarget('./src/assets/**/*.{css,js,svg,png,jpeg}');
  eleventyConfig.addWatchTarget('./src/_includes/**/*.{webc}');

  // --------------------- layout aliases
  eleventyConfig.addLayoutAlias('base', 'base.njk');
  eleventyConfig.addLayoutAlias('page', 'page.njk');
  eleventyConfig.addLayoutAlias('post', 'post.njk');
  eleventyConfig.addLayoutAlias('tags', 'tags.njk');

  //	---------------------  Collections
  eleventyConfig.addCollection('allPosts', getAllPosts);
  eleventyConfig.addCollection('showInSitemap', showInSitemap);
  eleventyConfig.addCollection('tagList', tagList);

  // ---------------------  Plugins
  eleventyConfig.addPlugin(plugins.htmlConfig);
  eleventyConfig.addPlugin(plugins.drafts);

  eleventyConfig.addPlugin(plugins.EleventyRenderPlugin);
  eleventyConfig.addPlugin(plugins.rss);
  eleventyConfig.addPlugin(plugins.syntaxHighlight);

  eleventyConfig.addPlugin(plugins.webc, {
    components: ['./src/_includes/webc/**/*.webc'],
    useTransform: true
  });

  eleventyConfig.addPlugin(plugins.eleventyImageTransformPlugin, {
    formats: ['webp', 'jpeg'],
    widths: ['auto'],
    htmlOptions: {
      imgAttributes: {
        loading: 'lazy',
        decoding: 'async'
      },
      pictureAttributes: {}
    }
  });

  // ---------------------  bundle
  eleventyConfig.addBundle('css', {hoist: true});

  // 	--------------------- Library and Data
  eleventyConfig.setLibrary('md', plugins.markdownLib);
  eleventyConfig.addDataExtension('yaml', contents => yamlLoad(contents));

  // --------------------- Filters
  eleventyConfig.addFilter('toIsoString', filters.toISOString);
  eleventyConfig.addFilter('formatDate', filters.formatDate);
  eleventyConfig.addFilter('markdownFormat', filters.markdownFormat);
  eleventyConfig.addFilter('splitlines', filters.splitlines);
  eleventyConfig.addFilter('striptags', filters.striptags);
  eleventyConfig.addFilter('shuffle', filters.shuffleArray);
  eleventyConfig.addFilter('alphabetic', filters.sortAlphabetically);
  eleventyConfig.addFilter('slugify', filters.slugifyString);

  // --------------------- Shortcodes
  eleventyConfig.addShortcode('svg', shortcodes.svgShortcode);
  eleventyConfig.addShortcode('image', shortcodes.imageShortcode);
  eleventyConfig.addShortcode('imageKeys', shortcodes.imageKeysShortcode);
  eleventyConfig.addShortcode('year', () => `${new Date().getFullYear()}`);

  // --------------------- Cloudinary picture shortcode
  // The shortcode emits a placeholder element. A transform later turns it into
  // the real <picture>. This prevents Eleventy's image transform plugin from
  // replacing our Cloudinary URLs with local webp/jpeg files.
  eleventyConfig.addShortcode('cloudinaryPicture', (rawOptions) => {
    const opts = parseOptions(rawOptions);
    return optionsToCustomElementTag(opts);
  });

  eleventyConfig.addTransform('cloudinary-picture', function (content) {
    const outputPath = this.page?.outputPath;
    if (typeof outputPath !== 'string' || !outputPath.endsWith('.html')) return content;

    return content.replace(
      /<cloudinary-picture\b([^>]*)>(?:<\/cloudinary-picture>)?/g,
      (_, attrString) => {
        try {
          const attrs = parseHtmlAttributes(attrString);
          return renderCloudinaryPicture(attrs);
        } catch (err) {
          console.error(`[cloudinary-picture transform] ${err.message}`);
          return `<!-- cloudinary-picture error: ${escapeHtml(err.message)} -->`;
        }
      }
    );
  });

  // --------------------- Events: after build
  if (process.env.ELEVENTY_RUN_MODE === 'serve') {
    eleventyConfig.on('eleventy.after', events.svgToJpeg);
  }

  // --------------------- Passthrough File Copy

  // -- same path
  ['src/assets/fonts/', 'src/assets/images/template', 'src/assets/og-images'].forEach(path =>
    eleventyConfig.addPassthroughCopy(path)
  );

  eleventyConfig.addPassthroughCopy({
    // -- to root
    'src/assets/images/favicon/*': '/',

    // -- node_modules
    'node_modules/lite-youtube-embed/src/lite-yt-embed.{css,js}': `assets/components/`
  });

  // ----------------------  ignore test files
  if (process.env.ELEVENTY_ENV != 'test') {
    eleventyConfig.ignores.add('src/common/pa11y.njk');
  }

  // --------------------- general config
  return {
    markdownTemplateEngine: 'njk',

    dir: {
      output: 'dist',
      input: 'src',
      includes: '_includes',
      layouts: '_layouts'
    }
  };
}
