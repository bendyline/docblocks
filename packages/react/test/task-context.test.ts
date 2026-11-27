import { expect } from 'chai';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { taskFacts } from '../src/Ai/task-context.js';
import type { TaskItem } from '../src/Tasks/task-model.js';

function task(title: string, fields: Partial<TaskItem> = {}): TaskItem {
  return {
    workspaceId: 'w1',
    path: parseWorkspacePath(`Tasks/Active/${title}.md`),
    title,
    done: false,
    folder: parseWorkspacePath('Tasks'),
    bucket: 'Active',
    group: '',
    pending: false,
    lastModified: '',
    ...fields,
  };
}

describe('task facts for Ask', () => {
  const names = new Map([['w1', 'Personal']]);

  it('lists what is overdue, coming up and recently finished, exactly', () => {
    const facts = taskFacts(
      [
        task('Refund', { due: '2026-11-21' }),
        task('Call Priya', { due: '2026-11-24', category: 'Work' }),
        task('Dentist', { due: '2026-11-23T15:00' }),
        task('Far off', { due: '2027-03-01' }),
        task('Pay bill', { done: true, completedOn: '2026-11-22' }),
        task('Old', { done: true, completedOn: '2026-10-01' }),
        task('Someday'),
      ],
      '2026-11-23',
      names,
    );
    expect(facts).to.equal(
      [
        'Today is Monday 23 November 2026 (2026-11-23).',
        'Overdue:',
        '- Refund (was due 2026-11-21, 2 days ago; in Personal › Tasks › Active)',
        'Due in the next 14 days:',
        '- Dentist (due today; in Personal › Tasks › Active)',
        '- Call Priya (due tomorrow; category Work; in Personal › Tasks › Active)',
        'Finished in the last 7 days:',
        '- Pay bill (finished 2026-11-22; in Personal › Tasks › Active)',
      ].join('\n'),
    );
  });

  it('says nothing when there is nothing to tell', () => {
    expect(taskFacts([task('Someday')], '2026-11-23', names)).to.equal(null);
  });
});
