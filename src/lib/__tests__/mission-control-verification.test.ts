import { describe, expect, it } from 'vitest'

const {
  verifyCompletedRun,
} = require('../../../scripts/mission-control-verification.cjs')

describe('mission-control verification', () => {
  it('passes a valid completed run', () => {
    const result = verifyCompletedRun({
      status: 'OK',
      risk_level: 0,
      git: { is_clean: true },
      validation: {
        steps: [
          { step: 'typecheck', passed: true },
          { step: 'test', passed: true },
          { step: 'build', passed: true },
        ],
      },
    }, {
      requiredFields: ['status', 'risk_level'],
      requiredValidationCommands: ['typecheck', 'test', 'build'],
    })

    expect(result.status).toBe('PASS')
    expect(result.failures).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('fails when a required validation command fails', () => {
    const result = verifyCompletedRun({
      status: 'OK',
      risk_level: 0,
      validation: {
        steps: [
          { step: 'typecheck', passed: true },
          { step: 'test', passed: false },
          { step: 'build', passed: true },
        ],
      },
    }, {
      requiredFields: ['status', 'risk_level'],
      requiredValidationCommands: ['typecheck', 'test', 'build'],
    })

    expect(result.status).toBe('FAIL')
    expect(result.failures).toContain('Validation command failed: test')
  })

  it('fails when a required schema field is missing', () => {
    const result = verifyCompletedRun({
      status: 'OK',
    }, {
      requiredFields: ['status', 'risk_level'],
    })

    expect(result.status).toBe('FAIL')
    expect(result.failures).toContain('Missing required field: risk_level')
  })

  it('fails on an unknown run status value', () => {
    const result = verifyCompletedRun({
      status: 'DONE',
      risk_level: 0,
    }, {
      requiredFields: ['status', 'risk_level'],
    })

    expect(result.status).toBe('FAIL')
    expect(result.failures).toContain('Unknown status value: DONE')
  })

  it('warns when git state is dirty unexpectedly', () => {
    const result = verifyCompletedRun({
      status: 'OK',
      risk_level: 0,
      git: { is_clean: false },
    }, {
      requiredFields: ['status', 'risk_level'],
    })

    expect(result.status).toBe('WARN')
    expect(result.warnings).toContain('Working tree is dirty')
  })

  it('warns when a required validation command is explicitly not run', () => {
    const result = verifyCompletedRun({
      status: 'OK',
      risk_level: 0,
      validation: {
        steps: [
          { step: 'typecheck', passed: true },
          { step: 'test', passed: true },
          { step: 'build', passed: true, skipped: true },
        ],
      },
    }, {
      requiredFields: ['status', 'risk_level'],
      requiredValidationCommands: ['typecheck', 'test', 'build'],
    })

    expect(result.status).toBe('WARN')
    expect(result.warnings).toContain('Validation command not run: build')
  })
})
