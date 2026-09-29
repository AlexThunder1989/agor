import { describe, expect, it } from 'vitest';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

const allowed = {
  tenantId: 'tenant-a',
  config: { execution: { unix_user_mode: 'simple' as const } },
  sessionOwnerId: 'owner',
  sessionScope: 'execution_home' as const,
  prompterUserId: 'owner',
};

describe('OpenCode execution admission', () => {
  it('allows a locally contained prompt from the session owner', () => {
    expect(() => assertOpenCodeExecutionAllowed(allowed)).not.toThrow();
  });

  it('keeps execution-home prompts owner-bound', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({ ...allowed, prompterUserId: 'another-user' })
    ).toThrow(/session owner/i);
  });

  it('allows managed branch prompts but keeps execution-home owner-bound', () => {
    const managedConfig = {
      multi_tenancy: { mode: 'required_from_auth' as const },
      execution: {
        unix_user_mode: 'delegated' as const,
        executor_command_template: 'launch {command}',
        executor_storage: { user_home: 'persistent-per-user' as const },
        opencode_native_state_observer: { command_template: 'observe {run_id}' },
      },
      agentic_tools: { opencode_hosted_native_state: 'checkpointed' as const },
    };
    const shared = {
      ...allowed,
      config: managedConfig,
      sessionScope: 'branch' as const,
      prompterUserId: 'another-user',
    };
    expect(() => assertOpenCodeExecutionAllowed(shared)).not.toThrow();
    expect(() =>
      assertOpenCodeExecutionAllowed({ ...shared, sessionScope: 'execution_home' })
    ).toThrow(/session owner/i);
    expect(() =>
      assertOpenCodeExecutionAllowed({ ...shared, prompterUserId: 'owner' })
    ).not.toThrow();
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...shared,
        prompterUserId: 'owner',
        sessionScope: 'execution_home',
      })
    ).not.toThrow();
  });

  it('fails closed for branch-scoped native-file OpenCode and missing actors', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...allowed,
        sessionScope: 'branch',
      })
    ).toThrow(/managed Session state/);
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...allowed,
        prompterUserId: undefined,
      })
    ).toThrow(/Missing prompt actor/);
  });

  it('rejects execution whose writer cannot be locally contained', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...allowed,
        config: { execution: { executor_command_template: 'launch {command}' } },
      })
    ).toThrow(/locally containable executor process/i);
  });

  it('reports a hosted workspace with the structured unsupported reason', () => {
    let caught: unknown;
    try {
      assertOpenCodeExecutionAllowed({
        ...allowed,
        config: {
          multi_tenancy: { mode: 'required_from_auth' },
          execution: { unix_user_mode: 'delegated', executor_command_template: 'launch' },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: expect.stringMatching(/not been enabled/),
      data: { code: 'hosted_native_state_disabled' },
    });
  });
});
