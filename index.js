import * as core from '@actions/core';
import * as github from '@actions/github';
import {DefaultArtifactClient} from '@actions/artifact';
import * as exec from '@actions/exec';
import fs from 'fs';

// configuration
const artifactName = 'stale-approvals-shas';

// get inputs
const githubToken = core.getInput('github-token');
const fetchDepth = core.getInput('fetch-depth');
const shouldReRequest = core.getInput('re-request');
const dismissMessage = core.getInput('dismiss-message');
const showSummary = core.getInput('show-summary');
const ignoreBots = core.getInput('ignore-bots');
const dismissChangeRequested = core.getInput('dismiss-change-requested');

// setup
const artifact = new DefaultArtifactClient();
const octokit = github.getOctokit(githubToken);
const repository = github.context.repo.owner + '/' + github.context.repo.repo;
const prNumber = github.context.payload.pull_request?.number;

function getCurrentShas() {
    return [
        github.context.payload.pull_request?.head?.sha,
        github.context.payload.pull_request?.base?.sha,
    ];
}

function wasModified(rangeDiff) {
    return rangeDiff
        .split(/\r?\n/)
        .some(line => {
            const cols = line.trim().split(/\s+/);

            return cols[2] && cols[2] !== '=';
        });
}

async function pushArtifact() {
    fs.writeFileSync('shas.txt', getCurrentShas().join('\n'));

    await artifact.uploadArtifact(
        artifactName,
        ['shas.txt'],
        '.',
    );
}

async function getReviews() {
    const reviews = [];
    let page = 1;
    let data = [];
    do {
        core.info(`Fetch reviews page ${page}`);
        ({data} = await octokit.request(`GET /repos/${repository}/pulls/${prNumber}/reviews`, {
            per_page: 100,
            page,
        }));
        reviews.push(...data);
        page++;
    } while (data.length === 100);

    core.info(`Found ${reviews.length} reviews.`);

    return reviews;
}

async function removeReviews() {
    core.info('Dismissals reviews...');

    const latestReviewByUser = {};
    const reviews = await getReviews();
    for (const review of reviews) {
        if (!latestReviewByUser[review.user.id] || latestReviewByUser[review.user.id].submitted_at < review.submitted_at) {
            latestReviewByUser[review.user.id] = review;
        }
    }

    const dismissals = [];
    const rerequestReviewers = [];
    const dismissStates = [
        'APPROVED',
    ];

    if (dismissChangeRequested) {
        dismissStates.push('CHANGES_REQUESTED');
    }

    for (const review of Object.values(latestReviewByUser)) {
        core.info(`-> Review ${review.id} | user. ${review.user.login} | state: ${review.state} | ${review.submitted_at}`);

        if ((ignoreBots && review.user.type === 'Bot') || !dismissStates.includes(review.state)) {
            continue;
        }

        rerequestReviewers.push(review.user.login);
        core.info(`Dismiss review ${review.id} (${review.user.login})`);
        dismissals.push(octokit.request(`PUT /repos/${repository}/pulls/${prNumber}/reviews/${review.id}/dismissals`, {
            message: dismissMessage,
        }));
    }

    return Promise.allSettled(dismissals).then(() => {
        if (!shouldReRequest) {
            return Promise.resolve(rerequestReviewers);
        }

        core.info(`Re-request review for: ${rerequestReviewers.join(',')}`)

        return octokit
            .request(`POST /repos/${repository}/pulls/${prNumber}/requested_reviewers`, {
                reviewers: rerequestReviewers,
            })
            .then(() => rerequestReviewers);
    });
}

async function main() {
    const headRef = github.context.payload.pull_request?.head?.ref ?? github.context.ref;
    const workflowName = github.context.workflow;

    if (!prNumber) {
        core.setFailed('No pull request found.');
        return;
    }

    core.info(`Searching for workflow ${workflowName}`);
    const {data: {workflows}} = await octokit.request(`GET /repos/${repository}/actions/workflows`, {
        per_page: 100,
    });

    core.info(`${workflows.length} workflows found.`);

    const workflow = workflows.find(workflow => workflow.name === workflowName);
    if (!workflow) {
        core.setFailed(`Workflow "${workflowName}" not found.`);
        return;
    }

    // TODO is pagination really required?
    const {data: {workflow_runs: workflowRuns}} = await octokit.request(`GET /repos/${repository}/actions/workflows/${workflow.id}/runs`, {
        branch: headRef,
        status: 'success',
        per_page: 100,
    });

    core.info(`${workflowRuns.length} workflow runs found.`);

    if (!workflowRuns.length) {
        core.info(`No successful workflow run found for branch "${headRef}".`);
        return pushArtifact();
    }

    let shaArtifact;
    // search for the artifact in the last 10 workflow runs
    // if the workflow has multiple actions and this is skippable, the artifact will be not found in the latest workflow run
    for (let i = 0; i < Math.min(10, workflowRuns.length); i++) {
        core.info(`Search for artifact in workflow run ${workflowRuns[i].id}...`);
        const {data: {artifacts}} = await octokit.request(`GET /repos/${repository}/actions/runs/${workflowRuns[i].id}/artifacts`)
        core.info(`${artifacts.length} Artifacts found.`);
        shaArtifact = artifacts.find(artifact => artifact.name === artifactName);
        if (shaArtifact) {
            core.info('Artifact found.');
            break;
        }
        core.info('No sha artifact found.');
    }

    if (!shaArtifact) {
        core.info(`No artifacts found in workflow run ${workflowRuns[0].id}. Skipping check`);
        return pushArtifact();
    }

    core.info(`Downloading artifact ${shaArtifact.id} of workflow run ${workflowRuns[0].id}`);
    await artifact.downloadArtifact(shaArtifact.id, {
        findBy: {
            workflowRunId: workflowRuns[0].id,
            repositoryName: github.context.repo.repo,
            repositoryOwner: github.context.repo.owner,
            token: githubToken,
        },
        path: '/tmp/stale-approvals',
    });

    const [prevHeadSha, prevBaseSha] = fs.readFileSync('/tmp/stale-approvals/shas.txt', 'utf-8').split('\n');
    const [headSha, baseSha] = getCurrentShas();

    await exec.exec('git', [
        'fetch',
        '--no-tags',
        'origin',
        `--depth=${fetchDepth}`,
        prevBaseSha,
        prevHeadSha,
        baseSha,
        headSha,
    ]);

    const {stdout: prevMergeBase} = await exec.getExecOutput('git', [
        'merge-base',
        prevBaseSha,
        prevHeadSha,
    ]);
    const {stdout: currentMergeBase} = await exec.getExecOutput('git', [
        'merge-base',
        baseSha,
        headSha,
    ]);

    const {stdout: rangeDiff} = await exec.getExecOutput('git', [
        'range-diff',
        `${prevMergeBase}..${prevHeadSha}`.replace(/[\n\r]/g, ''),
        `${currentMergeBase}..${headSha}`.replace(/[\n\r]/g, ''),
    ]);

    if (wasModified(rangeDiff)) {
        const removedReviews = await removeReviews();

        if (showSummary) {
            await core.summary
                .addHeading('Stale Approvals')
                .addRaw('Changes/Diff detected, removing reviews:', true)
                .addList(removedReviews.map((user) => `@${user}`))
                .addEOL()
                .addCodeBlock(rangeDiff)
                .write()
        }
    } else if (showSummary) {
        await core.summary
            .addHeading('Stale Approvals')
            .addRaw('No changes detected.')
            .write()
    }

    return pushArtifact();
}

main();