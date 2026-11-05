import { spawn, SpawnOptionsWithoutStdio } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion, rejecting on non-zero exit. With `timeoutMs`
 * the command is killed (and the promise rejected) if it runs longer.
 * `onLine` gets each line of stdout as it comes (for progress).
 */
export function run(
  cmd: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
  timeoutMs?: number,
  onLine?: (line: string) => void,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;
    let pending = '';
    child.stdout?.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      if (!onLine) return;
      const lines = (pending + text).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to start "${cmd}": ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`"${cmd}" took longer than ${Math.round((timeoutMs ?? 0) / 1000)}s and was stopped`));
      } else if (code !== 0) {
        reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}\n${stderr.slice(-2000)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
