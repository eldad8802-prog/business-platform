import InventoryItemCard from "./inventory-item-card";

type Item = {
  id: number;
  name: string;
  barcode: string | null;
  unitType: string;
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
  imageUrl?: string | null;
};

type Props = {
  items: Item[];
};

export default function InventoryList({ items }: Props) {
  if (!items.length) {
    return (
      <div style={{ textAlign: "center", marginTop: "40px", color: "#6b7280" }}>
        אין מוצרים במלאי עדיין
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "12px",
        marginTop: "16px",
      }}
    >
   import InventoryItemCard from "./inventory-item-card";

{items.map((item) => (
  <InventoryItemCard
    key={item.id}
    id={item.id}
    name={item.name}
    imageUrl={item.imageUrl}
  />
))}
    </div>
  );
}