// =============================================================================
// Mathigon Studio Build Assets
// (c) Mathigon
// =============================================================================


const fs = require('fs');
const path = require('path');
const glob = require('glob');
const esbuild = require('esbuild');
const pug = require('pug');
const sass = require('sass');
const postcss = require('postcss');
const autoprefixer = require('autoprefixer');
const cssnano = require('cssnano');
const rtlcss = require('rtlcss');
const {cache} = require('@mathigon/core');

const {error, readFile, success, writeFile, CONFIG, STUDIO_ASSETS, PROJECT_ASSETS, CONTENT, OUTPUT, watchFiles, findFiles, textHash} = require('./utilities');
const {parseCourse, COURSE_URLS, writeCache} = require('./markdown');


// -----------------------------------------------------------------------------
// Styles

/** Supported browsers */
const BROWSERLIST = ['defaults', 'not ie <= 11', 'not ios < 10'];

/** CSS properties to exclude from RTL conversion. */
const RTL_EXCLUDE = ['background', 'background-color', 'background-image',
  'background-repeat', 'background-size', 'cursor'];

const SAFE_AREA_VARS = ['safe-area-inset-top', 'safe-area-inset-bottom',
  'safe-area-inset-left', 'safe-area-inset-right'];
const SAFE_AREA_EXPR = new RegExp(`env\\(\\s*(${SAFE_AREA_VARS.join('|')})\\s*,?\\s*([^)]+)?\\s*\\)`, 'g');

/** Custom PostCSS plugin for converting safe-area variables for iOS. */
const safeAreaCSS = {
  postcssPlugin: 'safe-area-inset',
  Declaration(decl) {
    const v1 = decl.value.replace(SAFE_AREA_EXPR, (_, param, value) => value || '0');
    if (v1 !== decl.value) decl.cloneBefore({value: v1});
    // const v2 = decl.value.replace(SAFE_AREA_EXPR, (_, param, value) => `constant(${param}${value ? `, ${value}` : ''})`);
    // if (v2 !== decl.value) decl.cloneBefore({value: v2});
  }
};

const getNodePaths = cache((src) => [0, 1, 2, 3, 4, 5]
    .map(i => path.join(src, '../'.repeat(i), 'node_modules')).filter(p => fs.existsSync(p)));

async function bundleStyles(srcPath, destPath, minify = false, watch = false) {
  // TODO Use github.com/madyankin/postcss-modules to scope all component classes
  if (destPath.endsWith('.scss')) destPath = destPath.replace('.scss', '.css');
  const start = Date.now();

  const output = sass.renderSync({
    file: srcPath,
    includePaths: getNodePaths(path.dirname(srcPath)),
    functions: {
      'uri-encode($str)': (str) => new sass.types.String(encodeURIComponent(str.getValue()))
    }
  });
  const files = output.stats.includedFiles;
  const banner = `/* ${CONFIG.banner}, generated by Mathigon Studio */\n`;

  for (const rtl of [false, true]) {
    const queue = postcss().use(autoprefixer(BROWSERLIST)).use(safeAreaCSS);
    if (rtl) queue.use(rtlcss([{blacklist: RTL_EXCLUDE, processEnv: false}]));
    if (minify) queue.use(cssnano());
    const transformed = (await queue.process(output.css, {from: undefined})).css;
    const dest = rtl ? destPath.replace('.css', '.rtl.css') : destPath;
    await writeFile(dest, banner + transformed);
  }

  if (watch) {
    watchFiles(files, () => bundleStyles(srcPath, destPath, minify));
    // TODO Update watched files when output.includedFiles changes
  }

  const ms = Date.now() - start;
  success(srcPath, ms);
}


// -----------------------------------------------------------------------------
// Scripts

// Custom Rollup plugin for importing PUG files in TS.
const pugPlugin = (__) => ({
  name: 'pug',
  setup: (build) => {
    build.onLoad({filter: /\.pug$/}, (args) => {
      const code = fs.readFileSync(args.path, 'utf8');
      const options = {compileDebug: false, filename: args.path, doctype: 'html'};
      const compiled = pug.compile(code, options)({__, config: CONFIG});
      return {contents: 'export default ' + JSON.stringify(compiled)};
    });
  }
});

const vuePlugin = {
  name: 'external',
  setup(build) {
    build.onResolve({filter: /^vue$/}, args => ({path: args.path, namespace: 'vue'}));
    build.onLoad({filter: /.*/, namespace: 'vue'}, () => ({contents: 'export default Vue'}));
  }
};

async function bundleScripts(srcPath, destPath, minify = false, watch = false, options = {}) {
  if (destPath.endsWith('.ts')) destPath = destPath.replace('.ts', '.js');
  if (srcPath.endsWith('.d.ts')) return;  // Skip declaration files
  const start = Date.now();
  let inputs;

  for (const locale of options.locales || ['en']) {
    const result = await esbuild.build({
      entryPoints: [srcPath],
      define: {ENV: `"${options.env || 'WEB'}"`, ICONS: 'undefined'},
      bundle: true,
      minify,
      globalName: options.name,
      platform: 'browser',
      format: 'iife',
      plugins: [pugPlugin(str => options.translate?.(locale, str) || str), vuePlugin],
      target: ['es2016'],
      metafile: watch,
      write: false,
      banner: {js: `/* ${CONFIG.banner}, generated by Mathigon Studio */`}
    });
    inputs = result.metafile?.inputs;

    const text = result.outputFiles[0].text.trim()
        .replace(/\/\*![\s\S]*?\*\//g, '')  // Remove comments
        .replace(/require\(['"]vue['"]\)/g, 'window.Vue')  // Fix imports;
        .replace(/\/icons\.svg/, iconsPath);  // Cache busting for icons

    // Replace localisation strings.
    const output = text.replace(/<<([\w\s:]+)>>/g, (_, str) => options.translate?.(locale, str) || str);

    const dest = locale === 'en' ? destPath : destPath.replace('.js', `.${locale}.js`);
    await writeFile(dest, output);
  }

  if (watch) {
    const cwd = process.cwd();
    const files = Object.keys(inputs).filter(f => !f.startsWith('node_modules')).map(f => path.join(cwd, f));
    watchFiles(files, () => bundleScripts(srcPath, destPath, minify, false, options));
    // TODO Update watched files when output.includedFiles changes
  }

  const ms = Date.now() - start;
  success(srcPath, ms);
}


// -----------------------------------------------------------------------------
// Markdown Courses

async function bundleMarkdown(id, locale, allLocales, watch = false, base = CONTENT) {
  const start = Date.now();

  const data = await parseCourse(path.join(base, id), locale, allLocales);
  if (!data) return;

  if (data.course) {
    const dest = path.join(OUTPUT, 'content', id, `data_${locale}.json`);
    await writeFile(dest, JSON.stringify(data.course));
    writeCache();
    success(`course ${id} [${locale}]`, Date.now() - start);
  }

  // TODO Also watch markdown dependencies (e.g. SVG, PUG or YAML files)
  if (watch) watchFiles([data.srcFile], () => bundleMarkdown(id, locale, allLocales, false, base));
}


// -----------------------------------------------------------------------------
// Miscellaneous Files

let iconsPath = '/icons.svg';

async function bundleIcons() {
  const start = Date.now();
  const icons = getAssetFiles('assets/icons/*.svg').map(({src}) => {
    const id = path.basename(src, '.svg');
    return readFile(src).replace(' xmlns="http://www.w3.org/2000/svg"', '')
        .replace('<svg ', `<symbol id="${id}" `).replace('</svg>', '</symbol>');
  });

  const symbols = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${icons.join('')}</svg>`;

  const hash = textHash(symbols).slice(0, 8);
  iconsPath = `/icons.${hash}.svg`;  // Add cache bust

  await writeFile(path.join(OUTPUT, 'icons.svg'), symbols);
  success(`icons.svg`, Date.now() - start);
}

async function createPolyfill() {
  const src = path.join(__dirname, '../node_modules');
  const f1 = readFile(src + '/web-animations-js/web-animations.min.js');
  const f2 = readFile(src + '/@webcomponents/custom-elements/custom-elements.min.js');

  const polyfill = [f1, f2].join('\n').replace(/\n\/\/# sourceMappingURL=.*\n/g, '\n');  // No Sourcemaps
  await writeFile(path.join(OUTPUT, 'polyfill.js'), polyfill);
}

async function createSitemap(URLs = []) {
  // TODO Generate sitemaps for locale subdomains
  // TODO Automatically generate the sitemap from Express router, rather than manually adding paths to config.yaml
  const options = '<changefreq>weekly</changefreq><priority>1.0</priority>';
  const urls = ['/', ...Array.from(COURSE_URLS), ...CONFIG.sitemap, ...URLs]
      .map(url => `<url><loc>https://${CONFIG.domain}${url}</loc>${options}</url>`);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`;
  await writeFile(path.join(OUTPUT, 'sitemap.xml'), sitemap);
}


// -----------------------------------------------------------------------------
// Tools

/** Get the basename of a path, but resolve /a/b/c/index.js to c.js. */
function basename(p) {
  const name = path.basename(p);
  const ext = path.extname(p);
  if (name.startsWith('index.')) return path.dirname(p).split(path.sep).pop() + ext;
  return name;
}

/**
 * Select all files in the project or the core frontend/ directory. Note that
 * the project may overwrite files with the same name.
 */
function getAssetFiles(pattern) {
  // Match abc.js as well as abc/index.js
  pattern = pattern.replace('*', '{*,*/index}');

  const projectFiles = glob.sync(pattern, {cwd: PROJECT_ASSETS}).map(c => path.join(PROJECT_ASSETS, c));
  const projectFileNames = projectFiles.map(p => basename(p));

  // Don't include any core files that are overwritten by the project.
  const studioFiles = glob.sync(pattern, {cwd: STUDIO_ASSETS}).map(c => path.join(STUDIO_ASSETS, c))
      .filter(p => !projectFileNames.includes(basename(p)));

  return [...studioFiles, ...projectFiles].map(src => {
    const dest = path.join(OUTPUT, basename(src));
    return {src, dest};
  });
}

async function buildAssets(minify = false, watch = false, locales = ['en']) {
  const promises = [];

  // SVG Icons need to be built BEFORE TS files, so that iconsPath is set.
  await bundleIcons().catch(error('icons.svg'));

  // Top-level TypeScript files
  for (const {src, dest} of getAssetFiles('*.ts')) {
    if (src.endsWith('.d.ts')) continue;
    promises.push(bundleScripts(src, dest, minify, watch).catch(error(src)));
  }
  promises.push(await createPolyfill().catch(error('polyfill.js')));

  // Top-level SCSS files
  for (const {src, dest} of getAssetFiles('*.scss')) {
    promises.push(bundleStyles(src, dest, minify, watch).catch(error(src)));
  }

  // Course TypeScript Files
  for (const {src, dest} of findFiles('!(shared|_*)/*.ts', CONTENT, OUTPUT + '/content')) {
    promises.push(bundleScripts(src, dest, minify, watch, {name: 'StepFunctions'}).catch(error(src)));
  }

  // Course SCSS Files
  for (const {src, dest} of findFiles('!(shared|_*)/*.scss', CONTENT, OUTPUT + '/content')) {
    promises.push(bundleStyles(src, dest, minify, watch).catch(error(src)));
  }

  await Promise.all(promises);

  // Course Markdown and YAML files
  // We run all course scripts in series, to avoid memory issues with large repositories.
  const courses = glob.sync('!(shared|_*|*.*)', {cwd: CONTENT});
  for (const id of courses) {
    for (const locale of locales) {
      await bundleMarkdown(id, locale, locales, watch).catch(error(`course ${id} [${locale}]`));
    }
  }

  // Generate the sitemap after all other assets have been compiled
  await createSitemap().catch(error('sitemap.xml'));
}


module.exports.bundleStyles = bundleStyles;
module.exports.bundleScripts = bundleScripts;
module.exports.bundleMarkdown = bundleMarkdown;
module.exports.bundleIcons = bundleIcons;
module.exports.createSitemap = createSitemap;
module.exports.createPolyfill = createPolyfill;

module.exports.buildAssets = buildAssets;
