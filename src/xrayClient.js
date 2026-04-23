import axios from 'axios';

const XRAY_AUTH_URL = 'https://xray.cloud.getxray.app/api/v2/authenticate';
const XRAY_GRAPHQL_URL = 'https://xray.cloud.getxray.app/api/v2/graphql';

/**
 * Xray Cloud API client.
 * Docs: https://docs.getxray.app/display/XRAYCLOUD/REST+API
 *
 * Authentication: Client ID + Client Secret → JWT token
 * Generate API keys at: Jira Settings → Apps → Xray → API Keys
 */
export class XrayClient {
  constructor({ clientId, clientSecret }) {
    if (!clientId || !clientSecret) {
      throw new Error('XrayClient requires clientId and clientSecret');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
  }

  /**
   * Authenticate and store the JWT token.
   */
  async authenticate() {
    const response = await axios.post(
      XRAY_AUTH_URL,
      { client_id: this.clientId, client_secret: this.clientSecret },
      { headers: { 'Content-Type': 'application/json' } }
    );
    // Xray returns the token as a plain JSON string (quoted)
    this.token = typeof response.data === 'string'
      ? response.data.replace(/^"|"$/g, '')
      : response.data;
    return this.token;
  }

  /**
   * Ensure we have a valid token, authenticating if needed.
   */
  async ensureAuth() {
    if (!this.token) await this.authenticate();
  }

  /**
   * Run a GraphQL query against the Xray Cloud API.
   * @param {string} query   GraphQL query string
   * @param {object} variables
   * @returns {object} data portion of the GraphQL response
   */
  async graphql(query, variables = {}) {
    await this.ensureAuth();
    const response = await axios.post(
      XRAY_GRAPHQL_URL,
      { query, variables },
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (response.data.errors?.length) {
      throw new Error(
        `Xray GraphQL errors: ${JSON.stringify(response.data.errors)}`
      );
    }
    return response.data.data;
  }

  /**
   * Fetch test steps for a given Jira issue key.
   *
   * Works for Xray Test issues (issue type = Test).
   * For Test Execution issues, use getTestExecutionTests().
   *
   * @param {string} issueKey  e.g. "ACANDMAU-499"
   * @returns {Array<{id, action, data, result, attachments}>}
   */
  async getTestSteps(issueKey) {
    const query = /* graphql */ `
      query GetTestSteps($jql: String!) {
        getTests(jql: $jql, limit: 1) {
          results {
            issueId
            testType { name }
            steps {
              id
              action
              data
              result
              attachments { id filename }
              customFields { id name value }
            }
          }
        }
      }
    `;
    const data = await this.graphql(query, { jql: `key = ${issueKey}` });
    const tests = data?.getTests?.results ?? [];
    if (tests.length === 0) return [];
    return tests[0].steps ?? [];
  }

  /**
   * If ACANDMAU-499 is a Test Execution, fetch its linked tests + their steps.
   *
   * @param {string} issueKey
   * @returns {Array<{testKey, testSummary, steps}>}
   */
  async getTestExecutionTests(issueKey) {
    const query = /* graphql */ `
      query GetTestExecution($jql: String!) {
        getTestExecutions(jql: $jql, limit: 1) {
          results {
            issueId
            tests(limit: 100) {
              results {
                issueId
                jira(fields: ["summary", "key"])
                testType { name }
                steps {
                  id
                  action
                  data
                  result
                  attachments { id filename }
                }
              }
            }
          }
        }
      }
    `;
    const data = await this.graphql(query, { jql: `key = ${issueKey}` });
    const executions = data?.getTestExecutions?.results ?? [];
    if (executions.length === 0) return [];

    return (executions[0].tests?.results ?? []).map((t) => ({
      testKey: t.jira?.key ?? t.issueId,
      testSummary: t.jira?.summary ?? '',
      testType: t.testType?.name ?? '',
      steps: t.steps ?? [],
    }));
  }

  /**
   * Auto-detect issue type and return normalised steps array.
   *
   * Returns an array of:
   *   { stepIndex, action, data, result, testKey, testSummary, testType }
   *
   * @param {string} issueKey
   * @param {'test'|'testExecution'|'auto'} mode
   * @returns {Array}
   */
  async getSteps(issueKey, mode = 'auto') {
    if (mode === 'test') {
      const steps = await this.getTestSteps(issueKey);
      return steps.map((s, i) => ({
        stepIndex: i + 1,
        testKey: issueKey,
        testSummary: '',
        testType: '',
        action: s.action ?? '',
        data: s.data ?? '',
        result: s.result ?? '',
      }));
    }

    if (mode === 'testExecution') {
      const tests = await this.getTestExecutionTests(issueKey);
      return tests.flatMap((t) =>
        t.steps.map((s, i) => ({
          stepIndex: i + 1,
          testKey: t.testKey,
          testSummary: t.testSummary,
          testType: t.testType,
          action: s.action ?? '',
          data: s.data ?? '',
          result: s.result ?? '',
        }))
      );
    }

    // auto: try Test first, fall back to Test Execution
    try {
      const steps = await this.getTestSteps(issueKey);
      if (steps.length > 0) {
        return steps.map((s, i) => ({
          stepIndex: i + 1,
          testKey: issueKey,
          testSummary: '',
          testType: '',
          action: s.action ?? '',
          data: s.data ?? '',
          result: s.result ?? '',
        }));
      }
    } catch (_) {
      // not a Test issue, continue
    }

    const tests = await this.getTestExecutionTests(issueKey);
    return tests.flatMap((t) =>
      t.steps.map((s, i) => ({
        stepIndex: i + 1,
        testKey: t.testKey,
        testSummary: t.testSummary,
        testType: t.testType,
        action: s.action ?? '',
        data: s.data ?? '',
        result: s.result ?? '',
      }))
    );
  }
}
