export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export class InventoryValidationError extends InventoryError {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

export class InventoryNotFoundError extends InventoryError {
  constructor(message = "Inventory item not found") {
    super(message);
    this.name = "InventoryNotFoundError";
  }
}

export class InventoryUnauthorizedError extends InventoryError {
  constructor(message = "Unauthorized inventory access") {
    super(message);
    this.name = "InventoryUnauthorizedError";
  }
}

export class NegativeInventoryError extends InventoryError {
  constructor(message = "Negative inventory is not allowed") {
    super(message);
    this.name = "NegativeInventoryError";
  }
}