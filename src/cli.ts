#!/usr/bin/env node
// rowebotic-review login | review <pr> | watch | serve

import { AuthError, login } from './auth.ts'
import { loadProject } from './config.ts'
import { GitHub } from './github.ts'
import { UsageLimitError } from './model.ts'
import { createReviewModel, reviewBatch, reviewPr } from './review.ts'
import { Watcher } from './watch.ts'

const usage = `usage:
  rowebotic-review login          sign in with your ChatGPT account (browser)
  rowebotic-review review <pr>    review one PR of the current repo and post the review
  rowebotic-review watch          review matching PRs in batches of up to five
  rowebotic-review serve          run the watcher and HTTP dashboard

Run review and watch from the repo root, which must contain .rowebotic-review/.`

function log(text: string) {
  console.log(`${new Date().toLocaleTimeString('en-GB', { hour12: false })} ${text}`)
}

async function main(argv: string[], signal: AbortSignal, stopping: AbortSignal): Promise<number> {
  const [command, ...rest] = argv
  const root = process.cwd()
  switch (command) {
    case 'login':
      await login(text => console.log(text), signal)
      return 0
    case 'review': {
      const number = Number(rest[0]?.replace(/^#/, ''))
      if (rest.length !== 1 || !Number.isInteger(number) || number <= 0) {
        console.error(usage)
        return 2
      }
      const outcome = await reviewPr({ root, prNumber: number, signal, stopping })
      return outcome.result.reviewPosted ? 0 : 1
    }
    case 'serve': {
      if (rest.length) {
        console.error(usage)
        return 2
      }
      const { serve } = await import('./serve.ts')
      await serve(log, signal, stopping)
      return 0
    }
    case 'watch': {
      if (rest.length) {
        console.error(usage)
        return 2
      }
      const project = await loadProject(root)
      if (!project.search) throw new Error('.rowebotic-review/settings.json needs "search" for watch')
      const github = new GitHub({ cwd: root, signal })
      const [repo, me] = await Promise.all([github.repo(), github.login()])
      if (!process.env.PGDATABASE) log('warning: PGDATABASE is not set; the psql functions will use libpq defaults')
      const model = await createReviewModel()
      const watcher = new Watcher({
        github,
        repo,
        login: me,
        search: project.search,
        reviewBatch: (prs, reviewSignal) => reviewBatch({ root, prs, signal: reviewSignal, stopping, model }),
        log,
        signal,
        stopping,
        idleDelay: project.idleDelay,
      })
      await watcher.run()
      return signal.aborted || stopping.aborted ? 130 : 0
    }
    default:
      console.error(usage)
      return command === undefined || command === '--help' || command === '-h' ? 0 : 2
  }
}

// The first signal is a soft stop: nothing new starts, but in-flight reviews carry on. Cloud Run
// sends SIGTERM about 10 seconds before SIGKILL, so a review that is nearly done can still post.
const stopping = new AbortController()
const controller = new AbortController()
let stops = 0
for (const name of ['SIGINT', 'SIGTERM'] as const) {
  process.on(name, () => {
    stops++
    if (stops === 1) {
      log('Stopping: no new work; in-flight reviews continue (Ctrl-C again to abort).')
      stopping.abort(new Error('stopping'))
    } else if (stops === 2) {
      log('Aborting (Ctrl-C again to force).')
      controller.abort(new Error('stopped by user'))
    } else {
      process.exit(130)
    }
  })
}

try {
  process.exitCode = await main(process.argv.slice(2), controller.signal, stopping.signal)
} catch (error) {
  if (controller.signal.aborted || stopping.signal.aborted) {
    process.exitCode = 130
  } else if (error instanceof UsageLimitError) {
    console.error(`Usage limit reached: ${error.message}${error.resetsAt ? `. Resets at ${new Date(error.resetsAt).toLocaleString()}` : ''}`)
    process.exitCode = 3
  } else if (error instanceof AuthError) {
    console.error(error.message)
    process.exitCode = 4
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  }
}
// MCP children and the Monty pool are closed by now. If a stray handle keeps
// the process alive, exit anyway; unref() lets a clean exit happen first.
setTimeout(() => process.exit(), 5000).unref()
