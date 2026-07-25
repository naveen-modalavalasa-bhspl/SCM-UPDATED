// @ts-nocheck
import React, { useState } from 'react';

/**
 * BavyaKanban — generic kanban board with brand-styled columns + drag/drop.
 *
 * Props:
 *   columns: [{ key, label, color, count? }]
 *   items:   [{ id, columnKey, ...renderProps }]
 *   renderCard(item):  React node — what each card looks like
 *   onMove(itemId, newColumnKey):  optional — called on drop
 *   onCardClick(item): optional — clicking the card body
 *
 * The board is horizontally scrollable on narrow screens.
 */
const BavyaKanban = ({ columns, items, renderCard, onMove, onCardClick }) => {
  const [draggingId, setDraggingId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const itemsByCol = columns.reduce((acc, c) => {
    acc[c.key] = items.filter((i) => i.columnKey === c.key);
    return acc;
  }, {});

  return (
    <div className="bavya-kanban">
      {columns.map((col) => {
        const colItems = itemsByCol[col.key] || [];
        const isDropZone = dropTarget === col.key;
        return (
          <div
            key={col.key}
            className={`bavya-kanban-col ${isDropZone ? 'drop-active' : ''}`}
            style={{ '--col-color': col.color || '#7A6D66' }}
            onDragOver={(e) => {
              // Always preventDefault so the column accepts the drop —
              // some browsers (Firefox especially) don't reliably surface
              // dragstart-set state before the first dragover fires.
              e.preventDefault();
              if (draggingId) setDropTarget(col.key);
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (draggingId && onMove) {
                const dragged = items.find((i) => String(i.id) === draggingId);
                if (dragged && dragged.columnKey !== col.key) {
                  onMove(dragged.id, col.key);
                }
              }
              setDraggingId(null);
              setDropTarget(null);
            }}
          >
            <div className="bavya-kanban-col-hdr">
              <span className="dot" />
              <span className="lbl">{col.label}</span>
              <span className="cnt">{colItems.length}</span>
            </div>
            <div className="bavya-kanban-col-body">
              {colItems.length === 0 && (
                <div className="bavya-kanban-empty">Nothing here.</div>
              )}
              {colItems.map((item) => (
                <div
                  key={item.id}
                  className={`bavya-kanban-card ${
                    String(item.id) === draggingId ? 'dragging' : ''
                  }`}
                  draggable={!!onMove}
                  onDragStart={() => setDraggingId(String(item.id))}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropTarget(null);
                  }}
                  onClick={() => onCardClick && onCardClick(item)}
                >
                  {renderCard(item)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default BavyaKanban;
