import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const COMPOSE_PROJECT_PREFIX = 'ld-';

function projectName(name: string): string {
  return `${COMPOSE_PROJECT_PREFIX}${name}`;
}

function generateNetworkOverride(name: string, services: Record<string, { port: number }>): string {
  let yaml = `networks:\n  leafdock_default:\n    external: true\n\nservices:\n`;
  for (const serviceName of Object.keys(services)) {
    const containerName = `${COMPOSE_PROJECT_PREFIX}${name}-${serviceName}`;
    yaml += `  ${serviceName}:\n    container_name: ${containerName}\n    networks:\n      - leafdock_default\n`;
  }
  return yaml;
}

function composeDir(name: string): string {
  return path.join(process.env.DATA_DIR || '/data', 'apps', name);
}

export async function composeUp(name: string, services: Record<string, { port: number }>): Promise<void> {
  const dir = composeDir(name);
  const networkFile = path.join(dir, 'docker-compose.network.yml');

  // Write network override so services join the Caddy network
  fs.writeFileSync(networkFile, generateNetworkOverride(name, services), 'utf-8');

  const composeFiles = `-f docker-compose.yml -f docker-compose.network.yml`;
  await execAsync(`docker compose ${composeFiles} -p ${projectName(name)} up -d`, {
    cwd: dir,
  });
}

export async function composeDown(name: string): Promise<void> {
  const dir = composeDir(name);
  try {
    await execAsync(`docker compose -p ${projectName(name)} down --remove-orphans`, { cwd: dir });
  } catch {
    // Project might not exist
  }
  // Clean up network override
  const networkFile = path.join(dir, 'docker-compose.network.yml');
  try { fs.rmSync(networkFile); } catch {}
}

export async function composeDownForDir(dir: string): Promise<void> {
  try {
    await execAsync(`docker compose down --remove-orphans`, { cwd: dir });
  } catch {
    // Project might not exist
  }
  const networkFile = path.join(dir, 'docker-compose.network.yml');
  try { fs.rmSync(networkFile); } catch {}
}

export async function composeLogs(name: string, tail: number): Promise<string> {
  const dir = composeDir(name);
  try {
    const { stdout } = await execAsync(
      `docker compose -p ${projectName(name)} logs --tail=${tail} --no-color 2>&1`,
      { cwd: dir, encoding: 'utf-8' }
    );
    return stdout;
  } catch {
    return '(error fetching logs)';
  }
}
