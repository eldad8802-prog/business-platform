import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { signAuthToken } from "@/lib/auth-token";
import { POST as postInventoryItem } from "@/app/api/inventory/items/route";
import { PATCH as patchInventoryItem } from "@/app/api/inventory/items/[id]/route";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createBusinessWithUser() {
  const business = await prisma.business.create({
    data: {
      name: `P1 Sell Price ${runId}`,
      users: {
        create: {
          email: `p1-sell-price-${runId}@example.test`,
          password: "test-password",
          name: "P1 Sell Price User",
        },
      },
    },
    include: { users: true },
  });

  return {
    businessId: business.id,
    userId: business.users[0]!.id,
  };
}

async function cleanupItem(itemId: number) {
  await prisma.inventoryMovement.deleteMany({ where: { itemId } });
  await prisma.inventoryAlert.deleteMany({ where: { itemId } });
  await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
}

async function main() {
  const { businessId, userId } = await createBusinessWithUser();

  let authToken: string;
  try {
    authToken = signAuthToken(userId);
  } catch (error) {
    console.warn(
      "Skipping inventory-item-sell-price.api.test: AUTH_TOKEN_SECRET not configured.",
      error
    );
    await deleteTestBusinesses([businessId]);
    return;
  }

  const headers = { Authorization: `Bearer ${authToken}` };
  let createdItemId: number | null = null;

  try {
    // POST without sell price
    const createNoPriceReq = new NextRequest("http://localhost/api/inventory/items", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Item no price ${runId}`,
        unitType: "UNIT",
        initialQuantity: 0,
        minimumQuantity: 0,
      }),
    });
    const createNoPriceRes = await postInventoryItem(createNoPriceReq);
    assert.equal(createNoPriceRes.status, 201, "POST without price succeeds");
    const createNoPriceBody = await createNoPriceRes.json();
    assert.equal(
      createNoPriceBody.item.sellPricePerUnit,
      null,
      "POST without price stores null"
    );
    createdItemId = createNoPriceBody.item.id;

    // POST with active sell price
    const createWithPriceReq = new NextRequest("http://localhost/api/inventory/items", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Item with price ${runId}`,
        unitType: "UNIT",
        initialQuantity: 0,
        minimumQuantity: 0,
        sellPricePerUnit: 49.9,
      }),
    });
    const createWithPriceRes = await postInventoryItem(createWithPriceReq);
    assert.equal(createWithPriceRes.status, 201, "POST with price succeeds");
    const createWithPriceBody = await createWithPriceRes.json();
    assert.equal(
      createWithPriceBody.item.sellPricePerUnit,
      49.9,
      "POST stores active sell price"
    );
    await cleanupItem(createWithPriceBody.item.id);

    // POST with zero normalizes to no price
    const createZeroReq = new NextRequest("http://localhost/api/inventory/items", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Item zero price ${runId}`,
        unitType: "UNIT",
        initialQuantity: 0,
        minimumQuantity: 0,
        sellPricePerUnit: 0,
      }),
    });
    const createZeroRes = await postInventoryItem(createZeroReq);
    assert.equal(createZeroRes.status, 201, "POST with zero succeeds");
    const createZeroBody = await createZeroRes.json();
    assert.equal(
      createZeroBody.item.sellPricePerUnit,
      null,
      "POST zero normalizes to null"
    );
    await cleanupItem(createZeroBody.item.id);

    // POST negative rejected
    const createNegativeReq = new NextRequest("http://localhost/api/inventory/items", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Item bad price ${runId}`,
        unitType: "UNIT",
        initialQuantity: 0,
        minimumQuantity: 0,
        sellPricePerUnit: -5,
      }),
    });
    const createNegativeRes = await postInventoryItem(createNegativeReq);
    assert.equal(createNegativeRes.status, 400, "POST negative price rejected");

    // PATCH set sell price
    const patchSetReq = new NextRequest(
      `http://localhost/api/inventory/items/${createdItemId}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sellPricePerUnit: 120 }),
      }
    );
    const patchSetRes = await patchInventoryItem(patchSetReq);
    assert.equal(patchSetRes.status, 200, "PATCH set price succeeds");
    const patchSetBody = await patchSetRes.json();
    assert.equal(patchSetBody.item.sellPricePerUnit, 120, "PATCH stores price");

    // PATCH clear sell price
    const patchClearReq = new NextRequest(
      `http://localhost/api/inventory/items/${createdItemId}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sellPricePerUnit: null }),
      }
    );
    const patchClearRes = await patchInventoryItem(patchClearReq);
    assert.equal(patchClearRes.status, 200, "PATCH clear price succeeds");
    const patchClearBody = await patchClearRes.json();
    assert.equal(patchClearBody.item.sellPricePerUnit, null, "PATCH clears price");

    // PATCH zero normalizes to null
    await patchInventoryItem(
      new NextRequest(`http://localhost/api/inventory/items/${createdItemId}`, {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sellPricePerUnit: 88 }),
      })
    );
    const patchZeroReq = new NextRequest(
      `http://localhost/api/inventory/items/${createdItemId}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sellPricePerUnit: 0 }),
      }
    );
    const patchZeroRes = await patchInventoryItem(patchZeroReq);
    assert.equal(patchZeroRes.status, 200, "PATCH zero succeeds");
    const patchZeroBody = await patchZeroRes.json();
    assert.equal(
      patchZeroBody.item.sellPricePerUnit,
      null,
      "PATCH zero normalizes to null"
    );

    // PATCH negative rejected
    const patchNegativeReq = new NextRequest(
      `http://localhost/api/inventory/items/${createdItemId}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sellPricePerUnit: -1 }),
      }
    );
    const patchNegativeRes = await patchInventoryItem(patchNegativeReq);
    assert.equal(patchNegativeRes.status, 400, "PATCH negative price rejected");

    console.log("inventory-item-sell-price.api.test: all assertions passed");
  } finally {
    if (createdItemId != null) {
      await cleanupItem(createdItemId);
    }
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
