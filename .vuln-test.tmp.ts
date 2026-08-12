import { LinuxArchExecutionLayer } from './src/agent-kernel/linux-arch-execution-layer';

async function main() {
  const layer = new LinuxArchExecutionLayer({ defaultAgentId: 'test', execRoot: process.cwd() });
  const cases = [
    { label: '/bin/bash -c', cmd: '/bin/bash -c echo pwned' },
    { label: '/usr/bin/python3 -c', cmd: '/usr/bin/python3 -c print(1)' },
    { label: 'code (bare, not in allowlist)', cmd: 'code --version' },
    { label: 'bash (bare, not in allowlist)', cmd: 'bash -c echo x' },
    { label: 'node -e', cmd: 'node -e console.log(42)' },
  ];
  for (const c of cases) {
    const r = await layer.execute({ commandLine: c.cmd });
    console.log(c.label, '→', r.status, '|', r.reason ?? `out:${JSON.stringify(r.stdout).slice(0,50)}`);
  }
}
main();
