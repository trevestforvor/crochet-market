const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ICONS_DIR = path.resolve(__dirname, '../icons');
const SIZE = 256;
const BADGE_H = 40;

// Model definitions: appname -> { avatarUrl, backend, bgColor }
const models = {
  llamacppqwen35a3buncensored: {
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/620760a26e3b7210c2ff1943/-s1gyJfvbE1RgO5iBeNOi.png',
    backend: 'llama.cpp',
    badgeColor: '#2d8cf0',
    badgeText: '#ffffff',
  },
  llamacppqwen3coder30ba3b: {
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/620760a26e3b7210c2ff1943/-s1gyJfvbE1RgO5iBeNOi.png',
    backend: 'llama.cpp',
    badgeColor: '#2d8cf0',
    badgeText: '#ffffff',
  },
  llamacppqwen314b: {
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/620760a26e3b7210c2ff1943/-s1gyJfvbE1RgO5iBeNOi.png',
    backend: 'llama.cpp',
    badgeColor: '#2d8cf0',
    badgeText: '#ffffff',
  },
  llamacppgemma312b: {
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/WtA3YYitedOr9n02eHfJe.png',
    backend: 'llama.cpp',
    badgeColor: '#2d8cf0',
    badgeText: '#ffffff',
  },
  vllmqwen3coder30ba3bfp4: {
    avatarUrl: 'https://cdn-avatars.huggingface.co/v1/production/uploads/620760a26e3b7210c2ff1943/-s1gyJfvbE1RgO5iBeNOi.png',
    backend: 'vLLM',
    badgeColor: '#7c3aed',
    badgeText: '#ffffff',
  },
};

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function createBadgeSvg(text, bgColor, textColor, width) {
  const fontSize = 16;
  const padding = 8;
  const badgeWidth = width;
  const badgeHeight = BADGE_H;
  const radius = 8;

  return Buffer.from(`<svg width="${badgeWidth}" height="${badgeHeight}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${badgeWidth}" height="${badgeHeight}"
          rx="${radius}" ry="${radius}" fill="${bgColor}" opacity="0.9"/>
    <text x="${badgeWidth / 2}" y="${badgeHeight / 2 + fontSize * 0.35}"
          font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold"
          fill="${textColor}" text-anchor="middle">${text}</text>
  </svg>`);
}

async function generateIcon(appName, config) {
  console.log(`Generating icon for ${appName}...`);

  // Download avatar
  const avatarBuf = await fetchBuffer(config.avatarUrl);

  // Resize avatar to fill the icon
  const avatar = await sharp(avatarBuf)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .png()
    .toBuffer();

  // Create badge
  const badgeWidth = config.backend === 'llama.cpp' ? 110 : 70;
  const badgeSvg = createBadgeSvg(config.backend, config.badgeColor, config.badgeText, badgeWidth);
  const badge = await sharp(badgeSvg).png().toBuffer();

  // Composite: avatar + badge in bottom-right corner
  const result = await sharp(avatar)
    .composite([
      {
        input: badge,
        gravity: 'southeast',
      },
    ])
    .png()
    .toBuffer();

  const outPath = path.join(ICONS_DIR, `${appName}.png`);
  fs.writeFileSync(outPath, result);
  console.log(`  -> ${outPath} (${Math.round(result.length / 1024)}KB)`);
}

async function main() {
  if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

  for (const [name, config] of Object.entries(models)) {
    try {
      await generateIcon(name, config);
    } catch (err) {
      console.error(`  ERROR for ${name}: ${err.message}`);
    }
  }
  console.log('\nDone! Run "node scripts/build-catalog.js" to update icons.json');
}

main();
