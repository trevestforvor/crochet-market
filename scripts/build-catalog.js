#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const CHARTS_DIR = path.join(ROOT, 'charts');
const ICONS_DIR = path.join(ROOT, 'icons');
const SRC_DIR = path.join(ROOT, 'src');

function findAppDirs() {
  return fs.readdirSync(ROOT).filter(name => {
    if (name === 'node_modules' || name === '.git' || name === 'src' || name === 'scripts' || name === 'docs' || name === 'skills' || name === 'charts' || name === 'icons' || name.startsWith('.')) return false;
    const chartPath = path.join(ROOT, name, 'Chart.yaml');
    return fs.existsSync(chartPath) && fs.statSync(path.join(ROOT, name)).isDirectory();
  });
}

function readYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function buildCatalog() {
  const appDirs = findAppDirs();
  const catalog = { apps: [], version: Date.now().toString() };
  const icons = {};
  const charts = {};

  for (const appName of appDirs) {
    const appDir = path.join(ROOT, appName);
    const chart = readYaml(path.join(appDir, 'Chart.yaml'));
    const manifest = readYaml(path.join(appDir, 'OlaresManifest.yaml'));
    const i18nEn = readYaml(path.join(appDir, 'i18n', 'en-US', 'OlaresManifest.yaml'));

    if (!chart || !manifest) {
      console.warn(`Skipping ${appName}: missing Chart.yaml or OlaresManifest.yaml`);
      continue;
    }

    const appEntry = {
      name: appName,
      chartName: chart.name,
      version: chart.version,
      appVersion: chart.appVersion,
      title: (i18nEn && i18nEn.metadata && i18nEn.metadata.title) || manifest.metadata.title,
      description: (i18nEn && i18nEn.metadata && i18nEn.metadata.description) || manifest.metadata.description,
      icon: manifest.metadata.icon || '',
      category: (manifest.spec && manifest.spec.category) || 'AI',
      versionName: (manifest.spec && manifest.spec.versionName) || chart.version,
      fullDescription: (i18nEn && i18nEn.spec && i18nEn.spec.fullDescription) ||
                       (manifest.spec && manifest.spec.fullDescription) || '',
      developer: (manifest.spec && manifest.spec.developer) || '',
      license: manifest.spec && manifest.spec.license,
      requiredGpu: manifest.spec && manifest.spec.requiredGpu,
      limitedGpu: manifest.spec && manifest.spec.limitedGpu,
      requiredMemory: manifest.spec && manifest.spec.requiredMemory,
      limitedMemory: manifest.spec && manifest.spec.limitedMemory,
      supportArch: (manifest.spec && manifest.spec.supportArch) || ['amd64'],
    };

    catalog.apps.push(appEntry);

    // Read icon if exists
    const iconPath = path.join(ICONS_DIR, `${appName}.png`);
    if (fs.existsSync(iconPath)) {
      icons[appName] = fs.readFileSync(iconPath).toString('base64');
    }

    // Read chart .tgz if exists
    const tgzPattern = `${appName}-`;
    const chartFiles = fs.readdirSync(CHARTS_DIR).filter(f => f.startsWith(tgzPattern) && f.endsWith('.tgz'));
    if (chartFiles.length > 0) {
      const latestChart = chartFiles.sort().pop();
      charts[appName] = fs.readFileSync(path.join(CHARTS_DIR, latestChart)).toString('base64');
    }
  }

  // Write outputs to src/ for Worker import
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(path.join(SRC_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
  fs.writeFileSync(path.join(SRC_DIR, 'icons.json'), JSON.stringify(icons));
  fs.writeFileSync(path.join(SRC_DIR, 'charts.json'), JSON.stringify(charts));

  console.log(`Built catalog: ${catalog.apps.length} apps, ${Object.keys(icons).length} icons, ${Object.keys(charts).length} charts`);
}

buildCatalog();
