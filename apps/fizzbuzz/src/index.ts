/**
 * FizzBuzzを返す関数
 *
 * ```mermaid
 * flowchart TD
 *   A([Start]) --> B{n % 15 === 0 ?}
 *   B -->|Yes| C["return 'FizzBuzz'"]
 *   B -->|No| D{n % 3 === 0 ?}
 *   D -->|Yes| E["return 'Fizz'"]
 *   D -->|No| F{n % 5 === 0 ?}
 *   F -->|Yes| G["return 'Buzz'"]
 *   F -->|No| H["return n.toString()"]
 *   C --> I([End])
 *   E --> I
 *   G --> I
 *   H --> I
 * ```
 *
 * @param n - 数字
 * @returns FizzBuzz, Fizz, Buzz, 数字
 */
export function fizzBuzz(n: number) {
  if (n % 15 === 0) return 'FizzBuzz'
  if (n % 3 === 0) return 'Fizz'
  if (n % 5 === 0) return 'Buzz'
  return n.toString()
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest

  const fizzBuzzTestCases = [
    { input: 1, expected: '1' },
    { input: 2, expected: '2' },
    { input: 3, expected: 'Fizz' },
    { input: 4, expected: '4' },
    { input: 5, expected: 'Buzz' },
    { input: 6, expected: 'Fizz' },
    { input: 7, expected: '7' },
    { input: 8, expected: '8' },
    { input: 9, expected: 'Fizz' },
    { input: 10, expected: 'Buzz' },
    { input: 11, expected: '11' },
    { input: 12, expected: 'Fizz' },
    { input: 13, expected: '13' },
    { input: 14, expected: '14' },
    { input: 15, expected: 'FizzBuzz' },
  ]

  describe('fizzBuzz', () => {
    it.concurrent.each(fizzBuzzTestCases)(
      'fizzBuzz($input) -> $expected',
      ({ input, expected }) => {
        const result = fizzBuzz(input)
        expect(result).toBe(expected)
      },
    )
  })
}
