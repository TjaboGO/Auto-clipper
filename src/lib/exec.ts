import { spawn, SpawnOptionsWithoutStdio } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion, rejecting on non-zero exit. With `timeoutMs`
 * the command is killed (and the promise rejected) if it runs longer.
 */
export function run(
  cmd: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
  timeoutMs?: number,
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
    child.stdout?.on('data', (d) => (stdout += d.toString()));
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
