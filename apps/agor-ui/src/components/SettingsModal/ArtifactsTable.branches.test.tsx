/**
 * Artifact branch names resolve with the store's branch map empty (Step 3):
 * the table reads the branches its artifacts name by id.
 */
import type { AgorClient, Artifact, Branch } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { selectBranchById } from '../../store/selectors';
import { ArtifactsTable } from './ArtifactsTable';

const AUTHORITY = 'user-1:member:1';
const artifact = {
  artifact_id: 'artifact-1',
  name: 'API explorer',
  board_id: 'board-1',
  branch_id: 'branch-1',
  created_by: 'user-1',
  template: 'static',
  build_status: 'success',
  created_at: '2026-01-01T00:00:00Z',
  archived: false,
} as Artifact;
const branch = { branch_id: 'branch-1', name: 'checkout-flow', archived: false } as Branch;

beforeEach(() => {
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  agorStore.getState().setDataAuthority(AUTHORITY);
  agorStore.getState().setLoading(false);
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

it("reads an artifact's unloaded branch by id, so its name is searchable", async () => {
  const find = vi.fn(async () => [branch]);
  const client = { service: () => ({ find }) } as unknown as AgorClient;
  function Table() {
    const branchById = useAgorStore(selectBranchById);
    return (
      <ArtifactsTable
        client={client}
        artifactById={new Map([[artifact.artifact_id, artifact]])}
        branchById={branchById}
        boardById={new Map()}
        userById={new Map()}
      />
    );
  }
  render(
    <MemoryRouter>
      <Table />
    </MemoryRouter>
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'checkout' } });
  expect(await screen.findByText('API explorer')).toBeVisible();
  expect(find).toHaveBeenCalledTimes(1);
  expect(find).toHaveBeenCalledWith({
    query: { branch_id: { $in: ['branch-1'] }, archived: false, $limit: 1 },
  });
});
