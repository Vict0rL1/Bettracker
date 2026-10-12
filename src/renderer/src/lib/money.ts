import { createContext, useContext } from 'react'
import { moneyFormat, type MoneyFormat } from './format'

/**
 * How amounts are shown, set once near the root from the user's settings
 * (dollars, or units of their unit size). Outside a provider it is dollars,
 * so a component rendered on its own still reads the way it always has.
 */
export const MoneyContext = createContext<MoneyFormat>(moneyFormat(null))

export const useMoney = (): MoneyFormat => useContext(MoneyContext)
