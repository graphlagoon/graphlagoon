/**
 * Tests for pure logic functions from DevGeneratorView.vue.
 * These functions are redefined here since they're not exported from the SFC.
 */
import { describe, it, expect } from 'vitest'

type ColumnDataType = 'string' | 'int' | 'float' | 'boolean' | 'date' | 'timestamp'
type GeneratorType = 'random_string' | 'uuid' | 'sequence' | 'random_int' | 'random_float' |
  'random_bool' | 'random_date' | 'random_choice' | 'faker_name' | 'faker_email' |
  'faker_address' | 'faker_company' | 'constant'

interface ExtraColumnDefinition {
  name: string
  data_type: ColumnDataType
  generator: GeneratorType
}

const generators: { value: GeneratorType; label: string; dataTypes: ColumnDataType[] }[] = [
  { value: 'random_string', label: 'Random String', dataTypes: ['string'] },
  { value: 'uuid', label: 'UUID', dataTypes: ['string'] },
  { value: 'sequence', label: 'Sequence (0,1,2...)', dataTypes: ['int'] },
  { value: 'random_int', label: 'Random Integer', dataTypes: ['int'] },
  { value: 'random_float', label: 'Random Float', dataTypes: ['float'] },
  { value: 'random_bool', label: 'Random Boolean', dataTypes: ['boolean'] },
  { value: 'random_date', label: 'Random Date', dataTypes: ['date', 'timestamp'] },
  { value: 'random_choice', label: 'Random Choice', dataTypes: ['string'] },
  { value: 'faker_name', label: 'Fake Name', dataTypes: ['string'] },
  { value: 'faker_email', label: 'Fake Email', dataTypes: ['string'] },
  { value: 'faker_address', label: 'Fake Address', dataTypes: ['string'] },
  { value: 'faker_company', label: 'Fake Company', dataTypes: ['string'] },
  { value: 'constant', label: 'Constant Value', dataTypes: ['string', 'int', 'float', 'boolean'] },
]

function getDefaultGenerator(dataType: ColumnDataType): GeneratorType {
  const gen = generators.find(g => g.dataTypes.includes(dataType))
  return gen?.value || 'random_string'
}

function getAvailableGenerators(dataType: ColumnDataType) {
  return generators.filter(g => g.dataTypes.includes(dataType))
}

function onDataTypeChange(col: ExtraColumnDefinition) {
  col.generator = getDefaultGenerator(col.data_type)
}

describe('getDefaultGenerator', () => {
  it('returns random_string for string type', () => {
    expect(getDefaultGenerator('string')).toBe('random_string')
  })

  it('returns sequence for int type', () => {
    expect(getDefaultGenerator('int')).toBe('sequence')
  })

  it('returns random_float for float type', () => {
    expect(getDefaultGenerator('float')).toBe('random_float')
  })

  it('returns random_bool for boolean type', () => {
    expect(getDefaultGenerator('boolean')).toBe('random_bool')
  })

  it('returns random_date for date type', () => {
    expect(getDefaultGenerator('date')).toBe('random_date')
  })

  it('returns random_date for timestamp type', () => {
    expect(getDefaultGenerator('timestamp')).toBe('random_date')
  })
})

describe('getAvailableGenerators', () => {
  it('returns string-compatible generators for string type', () => {
    const gens = getAvailableGenerators('string')
    const values = gens.map(g => g.value)
    expect(values).toContain('random_string')
    expect(values).toContain('uuid')
    expect(values).toContain('random_choice')
    expect(values).toContain('faker_name')
    expect(values).toContain('constant')
    expect(values).not.toContain('random_int')
    expect(values).not.toContain('random_float')
  })

  it('returns int-compatible generators for int type', () => {
    const gens = getAvailableGenerators('int')
    const values = gens.map(g => g.value)
    expect(values).toContain('sequence')
    expect(values).toContain('random_int')
    expect(values).toContain('constant')
    expect(values).not.toContain('random_string')
  })

  it('returns date-compatible generators for date type', () => {
    const gens = getAvailableGenerators('date')
    const values = gens.map(g => g.value)
    expect(values).toContain('random_date')
    expect(values).not.toContain('random_string')
  })
})

describe('onDataTypeChange', () => {
  it('updates generator when data type changes', () => {
    const col: ExtraColumnDefinition = {
      name: 'test',
      data_type: 'string',
      generator: 'random_string',
    }

    col.data_type = 'int'
    onDataTypeChange(col)

    expect(col.generator).toBe('sequence')
  })

  it('updates to random_float for float type', () => {
    const col: ExtraColumnDefinition = {
      name: 'test',
      data_type: 'string',
      generator: 'random_string',
    }

    col.data_type = 'float'
    onDataTypeChange(col)

    expect(col.generator).toBe('random_float')
  })
})

describe('graph models visibility logic', () => {
  // Tests for the computed show* properties in DevGeneratorView
  type GraphModel = 'barabasi_albert' | 'erdos_renyi' | 'watts_strogatz' | 'complete' | 'cycle' | 'star' | 'random_tree'

  function getVisibility(model: GraphModel) {
    return {
      showAvgDegree: model === 'erdos_renyi' || model === 'barabasi_albert' || model === 'watts_strogatz',
      showRewiringProb: model === 'watts_strogatz',
    }
  }

  it('barabasi_albert shows avgDegree only', () => {
    const v = getVisibility('barabasi_albert')
    expect(v.showAvgDegree).toBe(true)
    expect(v.showRewiringProb).toBe(false)
  })

  it('erdos_renyi shows avgDegree only', () => {
    const v = getVisibility('erdos_renyi')
    expect(v.showAvgDegree).toBe(true)
    expect(v.showRewiringProb).toBe(false)
  })

  it('watts_strogatz shows avgDegree and rewiringProb', () => {
    const v = getVisibility('watts_strogatz')
    expect(v.showAvgDegree).toBe(true)
    expect(v.showRewiringProb).toBe(true)
  })

  it('complete shows no model-specific params', () => {
    const v = getVisibility('complete')
    expect(v.showAvgDegree).toBe(false)
    expect(v.showRewiringProb).toBe(false)
  })

  it('cycle shows no model-specific params', () => {
    const v = getVisibility('cycle')
    expect(v.showAvgDegree).toBe(false)
    expect(v.showRewiringProb).toBe(false)
  })

  it('star shows no model-specific params', () => {
    const v = getVisibility('star')
    expect(v.showAvgDegree).toBe(false)
    expect(v.showRewiringProb).toBe(false)
  })

  it('random_tree shows no model-specific params', () => {
    const v = getVisibility('random_tree')
    expect(v.showAvgDegree).toBe(false)
    expect(v.showRewiringProb).toBe(false)
  })
})
