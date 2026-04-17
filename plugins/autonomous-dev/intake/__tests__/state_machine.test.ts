/**
 * Unit tests for the state machine validation (SPEC-008-1-08).
 *
 * Covers:
 *  - Every valid (state, action) pair from the state transition table
 *  - Every invalid pair
 *  - InvalidStateError message includes current state and allowed actions
 *  - 100% of `validateStateTransition`
 *
 * @module state_machine.test
 */

import {
  validateStateTransition,
  InvalidStateError,
  STATE_TRANSITIONS,
} from '../../handlers/state_machine';
import type { RequestStatus } from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Valid transitions - the spec explicitly lists these pairs
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Array<{ state: RequestStatus; action: string }> = [
  { state: 'queued', action: 'cancel' },
  { state: 'queued', action: 'priority' },
  { state: 'active', action: 'cancel' },
  { state: 'active', action: 'pause' },
  { state: 'active', action: 'feedback' },
  { state: 'paused', action: 'cancel' },
  { state: 'paused', action: 'resume' },
  { state: 'failed', action: 'resume' },
  { state: 'failed', action: 'cancel' },
];

// ---------------------------------------------------------------------------
// Invalid transitions - the spec explicitly lists these pairs
// ---------------------------------------------------------------------------

const INVALID_TRANSITIONS: Array<{ state: RequestStatus; action: string }> = [
  { state: 'queued', action: 'pause' },
  { state: 'queued', action: 'resume' },
  { state: 'queued', action: 'feedback' },
  { state: 'active', action: 'priority' },
  { state: 'active', action: 'resume' },
  { state: 'paused', action: 'pause' },
  { state: 'paused', action: 'priority' },
  { state: 'paused', action: 'feedback' },
  { state: 'failed', action: 'pause' },
  { state: 'failed', action: 'priority' },
  { state: 'failed', action: 'feedback' },
];

// Terminal states: cancelled and done have NO valid actions
const TERMINAL_STATES: RequestStatus[] = ['cancelled', 'done'];
const ALL_ACTIONS = ['cancel', 'pause', 'resume', 'priority', 'feedback'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateStateTransition()', () => {
  // =========================================================================
  // Valid transitions
  // =========================================================================

  describe('valid transitions (should not throw)', () => {
    for (const { state, action } of VALID_TRANSITIONS) {
      it(`(${state}, ${action}) is allowed`, () => {
        expect(() => validateStateTransition(state, action)).not.toThrow();
      });
    }
  });

  // =========================================================================
  // Invalid transitions
  // =========================================================================

  describe('invalid transitions (should throw InvalidStateError)', () => {
    for (const { state, action } of INVALID_TRANSITIONS) {
      it(`(${state}, ${action}) throws InvalidStateError`, () => {
        expect(() => validateStateTransition(state, action)).toThrow(
          InvalidStateError,
        );
      });
    }
  });

  // =========================================================================
  // Terminal states: cancelled and done reject ALL actions
  // =========================================================================

  describe('terminal state: cancelled rejects all actions', () => {
    for (const action of ALL_ACTIONS) {
      it(`(cancelled, ${action}) throws InvalidStateError`, () => {
        expect(() => validateStateTransition('cancelled', action)).toThrow(
          InvalidStateError,
        );
      });
    }
  });

  describe('terminal state: done rejects all actions', () => {
    for (const action of ALL_ACTIONS) {
      it(`(done, ${action}) throws InvalidStateError`, () => {
        expect(() => validateStateTransition('done', action)).toThrow(
          InvalidStateError,
        );
      });
    }
  });

  // =========================================================================
  // Error message content
  // =========================================================================

  describe('error message includes current state and allowed actions', () => {
    it('includes current state in the error message', () => {
      try {
        validateStateTransition('queued', 'pause');
        fail('Expected InvalidStateError');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStateError);
        expect((err as InvalidStateError).message).toContain("'queued'");
      }
    });

    it('includes allowed actions in the error message', () => {
      try {
        validateStateTransition('queued', 'resume');
        fail('Expected InvalidStateError');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStateError);
        const msg = (err as InvalidStateError).message;
        expect(msg).toContain('cancel');
        expect(msg).toContain('priority');
      }
    });

    it('includes "none" for terminal states', () => {
      try {
        validateStateTransition('done', 'cancel');
        fail('Expected InvalidStateError');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStateError);
        expect((err as InvalidStateError).message).toContain('none');
      }
    });

    it('error message includes the attempted action', () => {
      try {
        validateStateTransition('active', 'priority');
        fail('Expected InvalidStateError');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStateError);
        expect((err as InvalidStateError).message).toContain('priority');
      }
    });

    it('error name is InvalidStateError', () => {
      try {
        validateStateTransition('paused', 'pause');
        fail('Expected InvalidStateError');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStateError);
        expect((err as Error).name).toBe('InvalidStateError');
      }
    });
  });

  // =========================================================================
  // STATE_TRANSITIONS table completeness
  // =========================================================================

  describe('STATE_TRANSITIONS table', () => {
    it('defines entries for all 6 request statuses', () => {
      const statuses: RequestStatus[] = [
        'queued',
        'active',
        'paused',
        'failed',
        'cancelled',
        'done',
      ];
      for (const status of statuses) {
        expect(STATE_TRANSITIONS[status]).toBeDefined();
      }
    });

    it('terminal states have empty action lists', () => {
      expect(STATE_TRANSITIONS.cancelled).toEqual([]);
      expect(STATE_TRANSITIONS.done).toEqual([]);
    });

    it('queued has exactly [cancel, priority]', () => {
      expect(STATE_TRANSITIONS.queued).toEqual(
        expect.arrayContaining(['cancel', 'priority']),
      );
      expect(STATE_TRANSITIONS.queued).toHaveLength(2);
    });

    it('active has exactly [cancel, pause, feedback]', () => {
      expect(STATE_TRANSITIONS.active).toEqual(
        expect.arrayContaining(['cancel', 'pause', 'feedback']),
      );
      expect(STATE_TRANSITIONS.active).toHaveLength(3);
    });

    it('paused has exactly [cancel, resume]', () => {
      expect(STATE_TRANSITIONS.paused).toEqual(
        expect.arrayContaining(['cancel', 'resume']),
      );
      expect(STATE_TRANSITIONS.paused).toHaveLength(2);
    });

    it('failed has exactly [resume, cancel]', () => {
      expect(STATE_TRANSITIONS.failed).toEqual(
        expect.arrayContaining(['resume', 'cancel']),
      );
      expect(STATE_TRANSITIONS.failed).toHaveLength(2);
    });
  });

  // =========================================================================
  // InvalidStateError is instanceof Error
  // =========================================================================

  describe('InvalidStateError class', () => {
    it('is an instance of Error', () => {
      const err = new InvalidStateError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(InvalidStateError);
    });

    it('preserves message', () => {
      const err = new InvalidStateError('custom message');
      expect(err.message).toBe('custom message');
    });
  });
});
