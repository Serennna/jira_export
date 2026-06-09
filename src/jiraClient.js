import axios from 'axios';

/**
 * Jira REST API client for Atlassian Cloud.
 * Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */
export class JiraClient {
  constructor({ baseUrl, email, apiToken }) {
    if (!baseUrl || !email || !apiToken) {
      throw new Error('JiraClient requires baseUrl, email, and apiToken');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.http = axios.create({
      baseURL: `${this.baseUrl}/rest/api/3`,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Fetch a single issue by key, including all fields.
   * @param {string} issueKey  e.g. "ACANDMAU-499"
   * @returns {object} Jira issue object
   */
  async getIssue(issueKey) {
    const response = await this.http.get(`/issue/${issueKey}`, {
      params: {
        expand: 'renderedFields,names,schema,transitions,operations,editmeta,changelog',
      },
    });
    return response.data;
  }

  /**
   * Search issues by JQL with automatic pagination.
   * Returns all matching issues (summarized) across all pages.
   *
   * @param {string} jql           e.g. 'project = ACIOSMAU AND issuetype = Test'
   * @param {number} [pageSize=100]  results per API call (max 100)
   * @returns {Array<object>}  array of summarized issue objects
   */
  async searchIssues(jql, pageSize = 100) {
    const allIssues = [];
    let nextPageToken = undefined;

    while (true) {
      const body = {
        jql,
        maxResults: pageSize,
        fields: [
          'summary', 'status', 'issuetype', 'priority',
          'assignee', 'reporter', 'created', 'updated',
          'labels', 'components', 'fixVersions', 'description',
        ],
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const response = await this.http.post('/search/jql', body);
      const { issues = [], isLast, nextPageToken: next } = response.data;

      allIssues.push(...issues.map(JiraClient.summarize));

      if (isLast || !next || issues.length === 0) break;
      nextPageToken = next;
    }

    return allIssues;
  }
    /**
   * Create a new Jira issue.
   * @param {object} fields  e.g. { project: { key }, issuetype: { name }, summary, ... }
   * @returns {{ id: string, key: string, self: string }}
   */
    async createIssue(fields) {
      const response = await this.http.post('/issue', { fields });
      return response.data;
    }
    

  /**
   * Fetch subtasks for an issue.
   * @param {string} issueKey
   * @returns {Array} list of subtask issue objects
   */
  async getSubtasks(issueKey) {
    const issue = await this.getIssue(issueKey);
    const subtasks = issue.fields?.subtasks ?? [];
    if (subtasks.length === 0) return [];

    const results = await Promise.all(
      subtasks.map((sub) => this.getIssue(sub.key))
    );
    return results;
  }

  /**
   * Flatten an Atlassian Document Format (ADF) node to plain text.
   * @param {object|string|null} adf
   * @returns {string}
   */
  static adfToText(adf) {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;

    const walk = (node) => {
      if (!node) return '';
      if (node.type === 'text') return node.text ?? '';
      if (node.type === 'hardBreak') return '\n';
      if (node.type === 'paragraph') {
        return (node.content ?? []).map(walk).join('') + '\n';
      }
      if (node.type === 'listItem') {
        return '- ' + (node.content ?? []).map(walk).join('').trim() + '\n';
      }
      if (node.type === 'orderedList' || node.type === 'bulletList') {
        return (node.content ?? []).map(walk).join('');
      }
      if (node.type === 'heading') {
        const level = node.attrs?.level ?? 1;
        const prefix = '#'.repeat(level) + ' ';
        return prefix + (node.content ?? []).map(walk).join('') + '\n';
      }
      if (node.content) return (node.content ?? []).map(walk).join('');
      return '';
    };

    return walk(adf).trim();
  }

  /**
   * Extract a concise summary object from a raw Jira issue.
   * @param {object} issue  raw Jira issue from getIssue()
   * @returns {object}
   */
  static summarize(issue) {
    const f = issue.fields ?? {};
    return {
      key: issue.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? '',
      issueType: f.issuetype?.name ?? '',
      priority: f.priority?.name ?? '',
      assignee: f.assignee?.displayName ?? '',
      reporter: f.reporter?.displayName ?? '',
      created: f.created ?? '',
      updated: f.updated ?? '',
      labels: (f.labels ?? []).join(', '),
      components: (f.components ?? []).map((c) => c.name).join(', '),
      fixVersions: (f.fixVersions ?? []).map((v) => v.name).join(', '),
      description: JiraClient.adfToText(f.description),
      url: `${issue.self?.split('/rest')[0] ?? ''}/browse/${issue.key}`,
    };
  }
}
