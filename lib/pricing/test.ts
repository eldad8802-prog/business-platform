import { normalizeInput } from "./normalize";
import { calculatePricing } from "./calculate";
import { checkMarket } from "./market-check";
import { buildExplanation } from "./explain";

const input = {
  materialCost: 50,
  laborMinutes: 60,
  hourlyRate: 100,
  overheadPercent: 10,
  marketLow: 120,
  marketHigh: 300,
};

const normalized = normalizeInput(input);

const result = calculatePricing(normalized);

const marketStatus = checkMarket(result.recommendedPrice, normalized);

const explanation = buildExplanation(result);

console.log("=== RESULT ===");
console.log(result);

console.log("=== MARKET ===");
console.log(marketStatus);

console.log("=== EXPLANATION ===");
console.log(explanation);