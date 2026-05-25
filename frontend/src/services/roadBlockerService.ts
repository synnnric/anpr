import type {
  RoadBlockerConfig,
  RoadBlockerStatusResponse,
  RoadBlockerOperationRequest,
  RoadBlockerOperationResponse,
} from '../types/roadblocker';

function buildBaseUrl(config: RoadBlockerConfig): string {
  return `http://${config.ip}:${config.port}`;
}

export async function getDeviceStatus(config: RoadBlockerConfig): Promise<RoadBlockerStatusResponse> {
  const url = `${buildBaseUrl(config)}/open/getStatus/${encodeURIComponent(config.deviceNo)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

export async function sendOperation(
  config: RoadBlockerConfig,
  request: RoadBlockerOperationRequest,
): Promise<RoadBlockerOperationResponse> {
  const url = `${buildBaseUrl(config)}/open/operation`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}
