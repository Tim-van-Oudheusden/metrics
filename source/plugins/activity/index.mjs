//Setup
export default async function({login, data, rest, q, account, imports}, {enabled = false, markdown = "inline", extras = false} = {}) {
  //Plugin execution
  try {
    //Check if plugin is enabled and requirements are met
    if ((!q.activity) || (!imports.metadata.plugins.activity.enabled(enabled, {extras})))
      return null

    //Context
    let context = {mode: "user"}
    if (q.repo) {
      console.debug(`metrics/compute/${login}/plugins > activity > switched to repository mode`)
      const {owner, repo} = data.user.repositories.nodes.map(({name: repo, owner: {login: owner}}) => ({repo, owner})).shift()
      context = {...context, mode: "repository", owner, repo}
    }

    //Load inputs
    let {limit, load, days, filter, visibility, timestamps, skipped, ignored} = imports.metadata.plugins.activity.inputs({data, q, account})
    if (!days)
      days = Infinity
    skipped.push(...data.shared["repositories.skipped"])
    ignored.push(...data.shared["users.ignored"])
    const pages = Math.ceil(load / 100)
    const codelines = 2

    //Get user recent activity
    console.debug(`metrics/compute/${login}/plugins > activity > querying api`)
    const events = []
    try {
      for (let page = 1; page <= pages; page++) {
        console.debug(`metrics/compute/${login}/plugins > activity > loading page ${page}/${pages}`)
        events.push(...(context.mode === "repository" ? await rest.activity.listRepoEvents({owner: context.owner, repo: context.repo, per_page: 100, page}) : await rest.activity.listEventsForAuthenticatedUser({username: login, per_page: 100, page})).data)
      }
    }
    catch (error) {
      console.debug(`metrics/compute/${login}/plugins > activity > no more page to load (${error.message})`)
    }
    console.debug(`metrics/compute/${login}/plugins > activity > ${events.length} events loaded`)

    //Since October 2025, the events API trims pull request and push payloads (https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads)
    //Missing details are fetched from the REST API, so only events that will be displayed are processed
    const pulls = new Map()
    const pull = (repo, pull_request) => {
      if (pull_request.user)
        return pull_request
      const [owner, name] = repo.split("/")
      const key = `${repo}#${pull_request.number}`
      if (!pulls.has(key))
        pulls.set(key, rest.pulls.get({owner, repo: name, pull_number: pull_request.number}).then(({data}) => data))
      return pulls.get(key)
    }
    const pushed = async (repo, {before, head, commits, size}) => {
      if (Array.isArray(commits))
        return {size, commits}
      const [owner, name] = repo.split("/")
      const format = ({sha, commit: {message, author}}) => ({sha, message, author})
      if (/^0+$/.test(before)) {
        const {data: commit} = await rest.repos.getCommit({owner, repo: name, ref: head})
        return {size: 1, commits: [format(commit)]}
      }
      const {data: {total_commits: total, commits: compared}} = await rest.repos.compareCommits({owner, repo: name, base: before, head})
      return {size: total, commits: compared.map(format)}
    }

    //Activity type produced by each supported event
    const types = {
      CommitCommentEvent: "comment",
      CreateEvent: "ref/create",
      DeleteEvent: "ref/delete",
      ForkEvent: "fork",
      GollumEvent: "wiki",
      IssueCommentEvent: "comment",
      IssuesEvent: "issue",
      MemberEvent: "member",
      PublicEvent: "public",
      PullRequestEvent: "pr",
      PullRequestReviewEvent: "review",
      PullRequestReviewCommentEvent: "comment",
      PushEvent: "push",
      ReleaseEvent: "release",
      WatchEvent: "star",
    }

    //Convert an event into an activity entry
    const convert = async ({type, payload, actor: {login: actor}, repo: {name: repo}, created_at}) => {
      //See https://docs.github.com/en/rest/using-the-rest-api/github-event-types
      const timestamp = new Date(created_at)
      switch (type) {
        //Commented on a commit
        case "CommitCommentEvent": {
          if (!["created"].includes(payload.action))
            return null
          const {comment: {user: {login: user}, commit_id: sha, body: content}} = payload
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "comment", on: "commit", actor, timestamp, repo, content: await imports.markdown(content, {mode: markdown, codelines}), user, mobile: null, number: sha.substring(0, 7), title: ""}
        }
        //Created a git branch or tag
        case "CreateEvent": {
          const {ref: name, ref_type: type} = payload
          return {type: "ref/create", actor, timestamp, repo, ref: {name, type}}
        }
        //Deleted a git branch or tag
        case "DeleteEvent": {
          const {ref: name, ref_type: type} = payload
          return {type: "ref/delete", actor, timestamp, repo, ref: {name, type}}
        }
        //Forked repository
        case "ForkEvent": {
          const {forkee: {full_name: forked}} = payload
          return {type: "fork", actor, timestamp, repo, forked}
        }
        //Wiki changes
        case "GollumEvent": {
          const {pages} = payload
          return {type: "wiki", actor, timestamp, repo, pages: pages.map(({title}) => title)}
        }
        //Commented on an issue
        case "IssueCommentEvent": {
          if (!["created"].includes(payload.action))
            return null
          const {issue: {user: {login: user}, title, number}, comment: {body: content, performed_via_github_app: mobile}} = payload
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "comment", on: "issue", actor, timestamp, repo, content: await imports.markdown(content, {mode: markdown, codelines}), user, mobile, number, title}
        }
        //Issue event
        case "IssuesEvent": {
          if (!["opened", "closed", "reopened"].includes(payload.action))
            return null
          const {action, issue: {user: {login: user}, title, number, body: content}} = payload
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "issue", actor, timestamp, repo, action, user, number, title, content: await imports.markdown(content, {mode: markdown, codelines})}
        }
        //Activity from repository collaborators
        case "MemberEvent": {
          if (!["added"].includes(payload.action))
            return null
          const {member: {login: user}} = payload
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "member", actor, timestamp, repo, user}
        }
        //Made repository public
        case "PublicEvent": {
          return {type: "public", actor, timestamp, repo}
        }
        //Pull requests events (trimmed payloads report merges with a dedicated "merged" action)
        case "PullRequestEvent": {
          if (!["opened", "closed", "merged"].includes(payload.action))
            return null
          const action = (payload.action === "closed") && (payload.pull_request.merged) ? "merged" : payload.action
          const {user: {login: user}, title, number, body: content, additions: added, deletions: deleted, changed_files: changed} = await pull(repo, payload.pull_request)
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "pr", actor, timestamp, repo, action, user, title, number, content: await imports.markdown(content, {mode: markdown, codelines}), lines: {added, deleted}, files: {changed}}
        }
        //Reviewed a pull request
        case "PullRequestReviewEvent": {
          const {review: {state: review}} = payload
          const {user: {login: user}, number, title} = await pull(repo, payload.pull_request)
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "review", actor, timestamp, repo, review, user, number, title}
        }
        //Commented on a pull request
        case "PullRequestReviewCommentEvent": {
          if (!["created"].includes(payload.action))
            return null
          const {comment: {body: content, performed_via_github_app: mobile}} = payload
          const {user: {login: user}, title, number} = await pull(repo, payload.pull_request)
          if (!imports.filters.text(user, ignored))
            return null
          return {type: "comment", on: "pr", actor, timestamp, repo, content: await imports.markdown(content, {mode: markdown, codelines}), user, mobile, number, title}
        }
        //Pushed commits
        case "PushEvent": {
          let {size, commits} = await pushed(repo, payload)
          commits = commits.filter(({author}) => imports.filters.text(author?.email, ignored))
          if (!commits.length)
            return null
          if (commits.slice(-1).pop()?.message.startsWith("Merge branch "))
            commits = commits.slice(-1)
          return {type: "push", actor, timestamp, repo, size, branch: payload.ref.match(/refs.heads.(?<branch>.*)/)?.groups?.branch ?? null, commits: commits.reverse().map(({sha, message}) => ({sha: sha.substring(0, 7), message}))}
        }
        //Released
        case "ReleaseEvent": {
          if (!["published"].includes(payload.action))
            return null
          const {action, release: {name, tag_name, prerelease, draft, body: content}} = payload
          return {type: "release", actor, timestamp, repo, action, name: name || tag_name, prerelease, draft, content: await imports.markdown(content, {mode: markdown, codelines})}
        }
        //Starred a repository
        case "WatchEvent": {
          if (!["started"].includes(payload.action))
            return null
          const {action} = payload
          return {type: "star", actor, timestamp, repo, action}
        }
      }
    }

    //Extract activity events (the events API does not guarantee chronological order)
    const activity = []
    const candidates = events
      .filter(({actor}) => account === "organization" ? true : actor.login?.toLocaleLowerCase() === login.toLocaleLowerCase())
      .filter(({created_at}) => Number.isFinite(days) ? new Date(created_at) > new Date(Date.now() - days * 24 * 60 * 60 * 1000) : true)
      .filter(event => visibility === "public" ? event.public : true)
      .filter(({type}) => (type in types) && (filter.includes("all") || filter.includes(types[type])))
      .filter(({repo: {name: repo}}) => imports.filters.repo(repo, skipped))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    for (const event of candidates) {
      if (activity.length >= limit)
        break
      try {
        const result = await convert(event)
        if (result)
          activity.push(result)
      }
      catch (error) {
        console.debug(`metrics/compute/${login}/plugins > activity > skipped ${event.type} ${event.id} (${error.message})`)
      }
    }

    //Results
    return {timestamps, events: activity}
  }
  //Handle errors
  catch (error) {
    throw imports.format.error(error)
  }
}
