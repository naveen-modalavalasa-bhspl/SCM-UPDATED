// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Select, Space, Tag, Switch, Typography, Button, message, Empty } from 'antd';
import { EnvironmentOutlined } from '@ant-design/icons';
import api from '../config/api';
import { formatNumber, getErrorMessage } from '../utils/helpers';

const { Text } = Typography;

const STATUS_COLOR = { empty: '#86efac', partial: '#fbbf24', full: '#ef4444' };

/**
 * BinPickerModal — replaces deep TreeSelect with progressive cascade
 * (warehouse → floor → aisle → rack) plus a clickable floor diagram.
 * Optional isometric 3D-look toggle.
 *
 * Props:
 *   open                bool
 *   onClose             () => void
 *   onSelect            (binId, binCode, binMeta) => void
 *   warehouseId         number | null  (defaults to first non-virtual)
 *   selectedBinId       number | null  (highlight if currently picked)
 */
const BinPickerModal = ({
  open,
  onClose,
  onSelect,
  warehouseId,
  selectedBinId,
}) => {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [floorId, setFloorId] = useState(undefined);
  const [aisleId, setAisleId] = useState(undefined);
  const [rackId, setRackId] = useState(undefined);
  const [iso, setIso] = useState(false);

  useEffect(() => {
    if (!open || !warehouseId) return;
    setLoading(true);
    api.get(`/warehouse/floor-plan/${warehouseId}`)
      .then((r) => {
        setPlan(r.data || null);
        const firstFloor = r.data?.floors?.[0];
        setFloorId(firstFloor?.id);
        setAisleId(undefined);
        setRackId(undefined);
      })
      .catch((e) => message.error(getErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [open, warehouseId]);

  const floors = plan?.floors || [];
  const currentFloor = useMemo(() => floors.find((f) => f.id === floorId), [floors, floorId]);
  const aisles = currentFloor?.lines || [];
  const currentAisle = useMemo(() => aisles.find((a) => a.id === aisleId), [aisles, aisleId]);
  const racks = currentAisle ? currentAisle.racks : aisles.flatMap((a) => a.racks);
  const currentRack = useMemo(() => racks.find((r) => r.id === rackId), [racks, rackId]);
  const visibleRacks = currentRack ? [currentRack] : racks;

  const pickBin = (bin) => {
    onSelect?.(bin.id, bin.code, bin);
    onClose?.();
  };

  return (
    <Modal
      title="Select Bin"
      open={open}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>Close</Button>,
      ]}
      width={920}
      styles={{ body: { padding: 16 } }}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          style={{ width: 220 }}
          placeholder="Floor"
          value={floorId}
          onChange={(v) => { setFloorId(v); setAisleId(undefined); setRackId(undefined); }}
          options={floors.map((f) => ({ label: `${f.code} — ${f.name}`, value: f.id }))}
          loading={loading}
        />
        <Select
          style={{ width: 220 }}
          placeholder="Aisle / Line"
          allowClear
          value={aisleId}
          onChange={(v) => { setAisleId(v); setRackId(undefined); }}
          options={aisles.map((a) => ({ label: `${a.code} — ${a.name}`, value: a.id }))}
          disabled={!currentFloor}
        />
        <Select
          style={{ width: 220 }}
          placeholder="Rack"
          allowClear
          value={rackId}
          onChange={setRackId}
          options={racks.map((r) => ({ label: `${r.code}${r.rack_type ? ` [${r.rack_type}]` : ''}`, value: r.id }))}
          disabled={!aisles.length}
        />
        <Space>
          <Text type="secondary">Iso 3D</Text>
          <Switch checked={iso} onChange={setIso} size="small" />
        </Space>
      </Space>

      <div style={{ marginBottom: 8 }}>
        <Space wrap>
          <Text type="secondary">Click a bin to select.</Text>
          <Tag color="green">Empty</Tag>
          <Tag color="orange">Partial</Tag>
          <Tag color="red">Full</Tag>
        </Space>
      </div>

      <div
        style={{
          minHeight: 360,
          maxHeight: 520,
          overflow: 'auto',
          background: '#fafafa',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 16,
          perspective: iso ? 1400 : 'none',
        }}
      >
        {!visibleRacks.length && (
          <Empty description={loading ? 'Loading…' : 'Pick a floor to see racks.'} />
        )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            transformStyle: 'preserve-3d',
            transform: iso ? 'rotateX(40deg) rotateZ(-15deg)' : 'none',
            transformOrigin: '0 0',
            transition: 'transform 0.4s ease',
          }}
        >
          {visibleRacks.map((rack) => {
            const isAType = (rack.rack_type || '').toUpperCase() === 'A';
            return (
              <div
                key={rack.id}
                style={{
                  position: 'relative',
                  background: isAType ? '#dbeafe' : '#fce7f3',
                  border: '1px solid #6b7280',
                  borderRadius: 4,
                  padding: '20px 8px 8px 8px',
                  minWidth: rack.w + 16,
                  minHeight: rack.h + 16,
                  boxShadow: iso ? '0 18px 24px rgba(0,0,0,0.15)' : 'none',
                  transformStyle: 'preserve-3d',
                  transform: iso ? 'translateZ(20px)' : 'none',
                }}
              >
                <div style={{ position: 'absolute', top: 4, left: 6, fontSize: 11, fontWeight: 700 }}>
                  {rack.code} {rack.rack_type ? `[${rack.rack_type}]` : ''}
                </div>
                <div style={{ position: 'relative', width: rack.w, height: rack.h - 4 }}>
                  {rack.bins.map((bin) => {
                    const picked = selectedBinId && Number(selectedBinId) === Number(bin.id);
                    return (
                      <div
                        key={bin.id}
                        onClick={() => pickBin(bin)}
                        title={`${bin.code} — ${formatNumber(bin.current_qty)}/${formatNumber(bin.capacity)} (${bin.occ_pct}%)`}
                        style={{
                          position: 'absolute',
                          left: bin.x,
                          top: bin.y,
                          width: bin.w,
                          height: bin.h,
                          background: STATUS_COLOR[bin.status] || '#e5e7eb',
                          border: picked ? '3px solid #2563eb' : '1px solid rgba(0,0,0,0.18)',
                          borderRadius: 3,
                          cursor: 'pointer',
                          fontSize: 9,
                          fontWeight: 600,
                          color: '#1f2937',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          boxShadow: picked ? '0 0 0 2px rgba(37,99,235,0.25)' : 'none',
                          transition: 'transform 0.1s',
                          transformStyle: 'preserve-3d',
                          transform: iso ? 'translateZ(8px)' : 'none',
                        }}
                      >
                        {bin.code?.split('-').slice(-1)[0]}
                        {picked && <EnvironmentOutlined style={{ marginLeft: 2, fontSize: 10 }} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
};

export default BinPickerModal;
