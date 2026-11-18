import { spawn } from 'node:child_process'

// Shell hooks launch git, package scripts and migrations. Let them finish
// cleanup on cancellation before another batch can reuse the checkout.
export async function runHook(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<number | null> {
  signal.throwIfAborted()
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  const group = child.pid
  let cleanup: Promise<void> | undefined

  const terminate = (name: NodeJS.Signals) => {
    if (group === undefined) return false
    try {
      process.kill(-group, name)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  const cancel = () => {
    if (!terminate('SIGTERM')) return
    cleanup = new Promise(resolve => {
      setTimeout(() => {
        terminate('SIGKILL')
        resolve()
      }, 1500)
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    signal.throwIfAborted()
    return code
  } finally {
    signal.removeEventListener('abort', cancel)
    await cleanup
  }
}
