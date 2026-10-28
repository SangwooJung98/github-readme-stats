import "@testing-library/jest-dom";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { calculateRank } from "../src/calculateRank.js";
import { fetchStats } from "../src/fetchers/stats-fetcher.js";
import { expect, it, describe, beforeEach, afterEach } from "@jest/globals";

// Test parameters.
const data_stats = {
  data: {
    user: {
      name: "Anurag Hazra",
      repositoriesContributedTo: { totalCount: 61 },
      contributionsCollection: {
        totalCommitContributions: 100,
        totalPullRequestReviewContributions: 50,
      },
      pullRequests: { totalCount: 300 },
      mergedPullRequests: { totalCount: 240 },
      openIssues: { totalCount: 100 },
      closedIssues: { totalCount: 100 },
      followers: { totalCount: 100 },
      repositoryDiscussions: { totalCount: 10 },
      repositoryDiscussionComments: { totalCount: 40 },
      repositories: {
        totalCount: 5,
        nodes: [
          { name: "test-repo-1", stargazers: { totalCount: 100 } },
          { name: "test-repo-2", stargazers: { totalCount: 100 } },
          { name: "test-repo-3", stargazers: { totalCount: 100 } },
        ],
        pageInfo: {
          hasNextPage: true,
          endCursor: "cursor",
        },
      },
    },
  },
};

const data_repo = {
  data: {
    user: {
      repositories: {
        nodes: [
          { name: "test-repo-4", stargazers: { totalCount: 50 } },
          { name: "test-repo-5", stargazers: { totalCount: 50 } },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: "cursor",
        },
      },
    },
  },
};

const data_repo_zero_stars = {
  data: {
    user: {
      repositories: {
        nodes: [
          { name: "test-repo-1", stargazers: { totalCount: 100 } },
          { name: "test-repo-2", stargazers: { totalCount: 100 } },
          { name: "test-repo-3", stargazers: { totalCount: 100 } },
          { name: "test-repo-4", stargazers: { totalCount: 0 } },
          { name: "test-repo-5", stargazers: { totalCount: 0 } },
        ],
        pageInfo: {
          hasNextPage: true,
          endCursor: "cursor",
        },
      },
    },
  },
};

const error = {
  errors: [
    {
      type: "NOT_FOUND",
      path: ["user"],
      locations: [],
      message: "Could not resolve to a User with the login of 'noname'.",
    },
  ],
};

const mock = new MockAdapter(axios);

beforeEach(() => {
  process.env.FETCH_MULTI_PAGE_STARS = "false"; // Set to `false` to fetch only one page of stars.
  mock.onPost("https://api.github.com/graphql").reply((cfg) => {
    return [
      200,
      cfg.data.includes("contributionsCollection") ? data_stats : data_repo,
    ];
  });
});

afterEach(() => {
  mock.reset();
});

describe("Test fetchStats", () => {
  it("should fetch correct stats", async () => {
    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it.each([0, 3])(
    "excludes issue repositories without changing other stats (%i issues)",
    async (issueCount) => {
      const baseline = await fetchStats("anuraghazra");
      mock.reset();
      mock.onPost("https://api.github.com/graphql").reply(200, {
        data: { ...data_stats.data, filteredIssues: { issueCount } },
      });

      const result = await fetchStats(
        "anuraghazra",
        false,
        [],
        false,
        false,
        false,
        ["org/menu-bot"],
      );
      expect(result).toEqual({
        ...baseline,
        totalIssues: issueCount,
        rank: calculateRank({
          all_commits: false,
          commits: 100,
          prs: 300,
          reviews: 50,
          issues: issueCount,
          repos: 5,
          stars: 300,
          followers: 100,
        }),
      });
      const { variables, query } = JSON.parse(mock.history.post[0].data);
      expect(variables.issueSearchQuery).toBe(
        "is:issue author:anuraghazra -repo:org/menu-bot",
      );
      expect(variables.filterIssues).toBe(true);
      expect(query).toContain("filteredIssues: search(type: ISSUE");
      expect(mock.history.post).toHaveLength(1);
    },
  );

  it("supports multiple full repository names without duplicate exclusions", async () => {
    mock.reset();
    mock.onPost("https://api.github.com/graphql").reply(200, {
      data: { ...data_stats.data, filteredIssues: { issueCount: 3 } },
    });
    await fetchStats("anuraghazra", false, [], false, false, false, [
      "org/menu-bot",
      " other/bot ",
      "org/menu-bot",
    ]);
    expect(
      JSON.parse(mock.history.post[0].data).variables.issueSearchQuery,
    ).toBe("is:issue author:anuraghazra -repo:org/menu-bot -repo:other/bot");
  });

  it.each([undefined, null, -1, 201, "3"])(
    "rejects missing or invalid filtered issue counts (%s)",
    async (issueCount) => {
      mock.reset();
      mock.onPost("https://api.github.com/graphql").reply(200, {
        data: { ...data_stats.data, filteredIssues: { issueCount } },
      });
      await expect(
        fetchStats("anuraghazra", false, [], false, false, false, [
          "org/menu-bot",
        ]),
      ).rejects.toThrow("Could not fetch filtered issues.");
    },
  );

  it.each(["menu-bot", "org/menu-bot is:pr", "org/bot/extra", "org/"])(
    "rejects an invalid repository filter (%s)",
    async (repo) => {
      await expect(
        fetchStats("anuraghazra", false, [], false, false, false, [repo]),
      ).rejects.toThrow(
        "exclude_issue_repos must contain owner/repository names.",
      );
      expect(mock.history.post).toHaveLength(0);
    },
  );

  it("should stop fetching when there are repos with zero stars", async () => {
    mock.reset();
    mock
      .onPost("https://api.github.com/graphql")
      .replyOnce(200, data_stats)
      .onPost("https://api.github.com/graphql")
      .replyOnce(200, data_repo_zero_stars);

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should throw error", async () => {
    mock.reset();
    mock.onPost("https://api.github.com/graphql").reply(200, error);

    await expect(fetchStats("anuraghazra")).rejects.toThrow(
      "Could not resolve to a User with the login of 'noname'.",
    );
  });

  it("should fetch total commits", async () => {
    mock
      .onGet("https://api.github.com/search/commits?q=author:anuraghazra")
      .reply(200, { total_count: 1000 });

    let stats = await fetchStats("anuraghazra", true);
    const rank = calculateRank({
      all_commits: true,
      commits: 1000,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 1000,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should throw specific error when include_all_commits true and invalid username", async () => {
    expect(fetchStats("asdf///---", true)).rejects.toThrow(
      new Error("Invalid username provided."),
    );
  });

  it("should throw specific error when include_all_commits true and API returns error", async () => {
    mock
      .onGet("https://api.github.com/search/commits?q=author:anuraghazra")
      .reply(200, { error: "Some test error message" });

    expect(fetchStats("anuraghazra", true)).rejects.toThrow(
      new Error("Could not fetch total commits."),
    );
  });

  it("should exclude stars of the `test-repo-1` repository", async () => {
    mock
      .onGet("https://api.github.com/search/commits?q=author:anuraghazra")
      .reply(200, { total_count: 1000 });

    let stats = await fetchStats("anuraghazra", true, ["test-repo-1"]);
    const rank = calculateRank({
      all_commits: true,
      commits: 1000,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 200,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 1000,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 200,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch two pages of stars if 'FETCH_MULTI_PAGE_STARS' env variable is set to `true`", async () => {
    process.env.FETCH_MULTI_PAGE_STARS = true;

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 400,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 400,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch one page of stars if 'FETCH_MULTI_PAGE_STARS' env variable is set to `false`", async () => {
    process.env.FETCH_MULTI_PAGE_STARS = "false";

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch one page of stars if 'FETCH_MULTI_PAGE_STARS' env variable is not set", async () => {
    process.env.FETCH_MULTI_PAGE_STARS = undefined;

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should not fetch additional stats data when it not requested", async () => {
    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch additional stats when it requested", async () => {
    let stats = await fetchStats("anuraghazra", false, [], true, true, true);
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 240,
      mergedPRsPercentage: 80,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 10,
      totalDiscussionsAnswered: 40,
      rank,
    });
  });
});
