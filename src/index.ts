import catalog from './catalog.json';
import icons from './icons.json';
import charts from './charts.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function handleHash(): Response {
  return jsonResponse({
    hash: catalog.version,
    version: catalog.version,
  });
}

function handleInfo(): Response {
  const apps = (catalog as any).apps.map((app: any) => ({
    name: app.name,
    chartName: app.chartName,
    version: app.version,
    title: app.title,
    description: app.description,
    icon: app.icon,
    category: app.category,
    versionName: app.versionName,
    developer: app.developer,
    requiredGpu: app.requiredGpu,
    limitedGpu: app.limitedGpu,
    requiredMemory: app.requiredMemory,
    limitedMemory: app.limitedMemory,
    supportArch: app.supportArch,
  }));

  return jsonResponse({
    apps,
    recommendApps: apps.map((a: any) => a.name),
    categories: ['AI'],
    tags: ['LLM', 'vLLM', 'llama.cpp', 'inference'],
    totalCount: apps.length,
  });
}

async function handleDetail(request: Request): Promise<Response> {
  const body = await request.json() as { names?: string[] };
  const names = body.names || [];
  const results = (catalog as any).apps.filter((app: any) => names.includes(app.name));
  return jsonResponse({ apps: results });
}

function handleChart(appName: string): Response {
  const chartData = (charts as Record<string, string>)[appName];
  if (!chartData) {
    return new Response('Chart not found', { status: 404, headers: CORS_HEADERS });
  }
  const buffer = Uint8Array.from(atob(chartData), c => c.charCodeAt(0));
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${appName}.tgz"`,
      ...CORS_HEADERS,
    },
  });
}

function handleIcon(iconName: string): Response {
  const name = iconName.replace(/\.png$/, '');
  const iconData = (icons as Record<string, string>)[name];
  if (!iconData) {
    return new Response('Icon not found', { status: 404, headers: CORS_HEADERS });
  }
  const buffer = Uint8Array.from(atob(iconData), c => c.charCodeAt(0));
  return new Response(buffer, {
    headers: { 'Content-Type': 'image/png', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (pathname === '/' || pathname === '/health') {
      return jsonResponse({ status: 'ok', apps: (catalog as any).apps.length });
    }

    // Market Source API
    if (pathname === '/api/v1/appstore/hash') return handleHash();
    if (pathname === '/api/v1/appstore/info') return handleInfo();
    if (pathname === '/api/v1/applications/info' && request.method === 'POST') {
      return handleDetail(request);
    }

    // Chart download: /api/v1/applications/{name}/chart
    const chartMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/chart$/);
    if (chartMatch) return handleChart(chartMatch[1]);

    // Icon download: /icons/{name}
    const iconMatch = pathname.match(/^\/icons\/([^/]+)$/);
    if (iconMatch) return handleIcon(iconMatch[1]);

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};
