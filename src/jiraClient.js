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
   * List available workflow transitions for an issue.
   * @param {string} issueKey
   * @returns {Promise<Array<{id: string, name: string, to?: {name?: string}}>>}
   */
  async getTransitions(issueKey) {
    const response = await this.http.get(`/issue/${issueKey}/transitions`);
    return response.data?.transitions ?? [];
  }

  /**
   * Transition issue by target status name (case-insensitive).
   * @param {string} issueKey
   * @param {string} targetStatusName
   * @returns {Promise<{id: string, name: string, to?: {name?: string}}>}
   */
  async transitionIssueToStatus(issueKey, targetStatusName) {
    if (!issueKey || !targetStatusName) {
      throw new Error('transitionIssueToStatus requires issueKey and targetStatusName');
    }

    const transitions = await this.getTransitions(issueKey);
    const normalizedTarget = String(targetStatusName).trim().toLowerCase();
    const matched = transitions.find((transition) => {
      const toName = transition?.to?.name ?? '';
      return toName.trim().toLowerCase() === normalizedTarget;
    });

    if (!matched) {
      const available = transitions
        .map((transition) => transition?.to?.name || transition?.name || '(unknown)')
        .filter(Boolean)
        .join(', ');
      throw new Error(
        `No transition found for status "${targetStatusName}" on ${issueKey}. `
        + `Available transitions: ${available || '(none)'}`,
      );
    }

    await this.http.post(`/issue/${issueKey}/transitions`, {
      transition: { id: matched.id },
    });

    return matched;
  }

  /**
   * Update issue fields.
   * @param {string} issueKey
   * @param {object} fields
   * @returns {Promise<void>}
   */
  async updateIssueFields(issueKey, fields) {
    if (!issueKey || !fields || typeof fields !== 'object') {
      throw new Error('updateIssueFields requires issueKey and fields');
    }
    await this.http.put(`/issue/${issueKey}`, { fields });
  }

  /**
   * Delete an issue link by link id.
   * @param {string|number} linkId
   * @returns {Promise<void>}
   */
  async deleteIssueLink(linkId) {
    if (!linkId) throw new Error('deleteIssueLink requires linkId');
    await this.http.delete(`/issueLink/${linkId}`);
  }

  /**
   * Create a Jira issue.
   *
   * @param {object} input
   * @param {string} input.projectKey
   * @param {string} input.issueTypeName
   * @param {string} input.summary
   * @param {string} [input.description]
   * @param {string[]} [input.labels]
   * @returns {Promise<{id: string, key: string, self: string}>}
   */
  async createIssue({
    projectKey,
    issueTypeName,
    summary,
    description = '',
    labels = [],
  }) {
    if (!projectKey || !issueTypeName || !summary) {
      throw new Error('createIssue requires projectKey, issueTypeName, and summary');
    }

    const fields = {
      project: { key: projectKey },
      issuetype: { name: issueTypeName },
      summary,
    };

    if (description) fields.description = JiraClient.textToAdf(description);
    if (labels.length > 0) fields.labels = labels;

    const response = await this.http.post('/issue', { fields });
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
   * Convert plain text to Atlassian Document Format.
   * @param {string} text
   * @returns {object}
   */
  static textToAdf(text) {
    const lines = String(text ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n');

    return {
      version: 1,
      type: 'doc',
      content: lines.map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : [],
      })),
    };
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
