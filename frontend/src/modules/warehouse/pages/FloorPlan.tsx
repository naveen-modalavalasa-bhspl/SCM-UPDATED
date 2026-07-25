// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Select, Space, Tag, Statistic, Row, Col, Typography, Button, message, Tooltip, Modal, Switch } from 'antd';
import { ReloadOutlined, EditOutlined, SaveOutlined, CloseOutlined, CompressOutlined } from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import api from '../config/api';
import { formatNumber, getErrorMessage } from '../utils/helpers';
import useAuthStore from '../store/authStore';

const { Text } = Typography;

const STATUS_COLOR = {
  empty: '#86efac',     // green
  partial: '#fbbf24',   // amber
  full: '#ef4444',      // red
};

const FloorPlan = () => {
  const userRoleCodes = useAuthStore((s) => s.user?.role_codes || []);
  const canEdit = userRoleCodes.some((r) => ['super_admin', 'admin', 'warehouse_manager'].includes(r));
  const [searchParams] = useSearchParams();
  const initialWhFromUrl = searchParams.get('warehouse_id');

  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState(initialWhFromUrl ? Number(initialWhFromUrl) : undefined);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [overrides, setOverrides] = useState({}); // {`${type}-${id}`: {x,y}}
  const [drag, setDrag] = useState(null);
  const [selectedBin, setSelectedBin] = useState(null);
  const containerRef = useRef(null);

  const loadWarehouses = useCallback(async () => {
    try {
      const r = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const items = r.data?.items || r.data?.data || r.data || [];
      const opts = items.map((w) => ({ label: `${w.code || ''} ${w.name || ''}`.trim(), value: w.id }));
      setWarehouses(opts);
      if (!warehouseId && opts.length) setWarehouseId(opts[0].value);
    } catch (e) {
      message.error(getErrorMessage(e));
    }
  }, [warehouseId]);

  const fetchPlan = useCallback(async () => {
    if (!warehouseId) return;
    setLoading(true);
    try {
      const r = await api.get(`/warehouse/floor-plan/${warehouseId}`);
      setPlan(r.data || null);
      setOverrides({});
    } catch (e) {
      message.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [warehouseId]);

  useEffect(() => { loadWarehouses(); }, []);
  useEffect(() => { fetchPlan(); }, [warehouseId]);

  const onDragStart = (e, kind, id, baseX, baseY) => {
    if (!editMode) return;
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    setDrag({
      kind, id,
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      baseX, baseY,
      containerLeft: rect?.left || 0,
      containerTop: rect?.top || 0,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      const dx = e.clientX - drag.pointerStartX;
      const dy = e.clientY - drag.pointerStartY;
      setOverrides((prev) => ({
        ...prev,
        [`${drag.kind}-${drag.id}`]: { x: drag.baseX + dx, y: drag.baseY + dy },
      }));
    };
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag]);

  const saveLayout = async () => {
    if (!plan || !Object.keys(overrides).length) {
      setEditMode(false);
      return;
    }
    const items = Object.entries(overrides).map(([k, v]) => {
      const [kind, idStr] = k.split('-');
      return { type: kind, id: Number(idStr), x: v.x, y: v.y };
    });
    try {
      await api.put(`/warehouse/floor-plan/${warehouseId}/layout`, { items });
      message.success(`Saved ${items.length} position(s)`);
      setOverrides({});
      setEditMode(false);
      fetchPlan();
    } catch (e) {
      message.error(getErrorMessage(e));
    }
  };

  const cancelEdit = () => {
    setOverrides({});
    setEditMode(false);
  };

  const eff = (kind, id, baseX, baseY) => {
    const o = overrides[`${kind}-${id}`];
    return o ? { x: o.x, y: o.y } : { x: baseX, y: baseY };
  };

  const totalBins = plan?.stats?.bins || 0;
  const occupied = plan?.stats?.occupied_bins || 0;
  const occPct = totalBins ? Math.round((occupied / totalBins) * 100) : 0;

  return (
    <div>
      <PageHeader
        title="Warehouse Floor Plan"
        subtitle="2D layout — drag floors / lines / racks to rearrange (edit mode), click bins to inspect"
      >
        <Space>
          <Select
            style={{ width: 280 }}
            placeholder="Select warehouse"
            value={warehouseId}
            onChange={setWarehouseId}
            options={warehouses}
            showSearch
            optionFilterProp="label"
          />
          <Button icon={<ReloadOutlined />} onClick={fetchPlan} loading={loading}>Refresh</Button>
          {canEdit && !editMode && (
            <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit Layout</Button>
          )}
          {editMode && (
            <>
              <Button icon={<SaveOutlined />} type="primary" onClick={saveLayout}>Save</Button>
              <Button icon={<CloseOutlined />} onClick={cancelEdit}>Cancel</Button>
            </>
          )}
        </Space>
      </PageHeader>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}><Card size="small"><Statistic title="Floors" value={plan?.stats?.floors || 0} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="Lines (aisles)" value={plan?.stats?.lines || 0} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="Racks" value={plan?.stats?.racks || 0} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="Bins" value={totalBins} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title="Occupancy" value={`${occupied}/${totalBins} (${occPct}%)`} /></Card></Col>
      </Row>

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space>
          <Text type="secondary">Legend:</Text>
          <Tag color="green">Empty</Tag>
          <Tag color="orange">Partial</Tag>
          <Tag color="red">Full</Tag>
          {editMode && <Tag color="blue">Edit mode — drag floors / racks to rearrange</Tag>}
        </Space>
      </Card>

      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: '100%',
          minHeight: 600,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          background: '#fafafa',
          overflow: 'auto',
          padding: 12,
        }}
      >
        {!plan?.floors?.length && (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            {loading ? 'Loading…' : 'No layout to render — pick a warehouse with floors / racks defined.'}
          </div>
        )}

        {plan?.floors?.map((floor) => {
          const fpos = eff('location', floor.id, floor.x, floor.y);
          return (
            <div
              key={floor.id}
              style={{
                position: 'absolute',
                left: fpos.x, top: fpos.y,
                width: floor.w, height: floor.h,
                background: '#fff',
                border: '2px solid #4b5563',
                borderRadius: 6,
                boxShadow: '0 2px 4px rgba(0,0,0,0.06)',
                cursor: editMode ? 'move' : 'default',
              }}
              onMouseDown={(e) => onDragStart(e, 'location', floor.id, fpos.x, fpos.y)}
            >
              <div style={{
                position: 'absolute', top: 4, left: 8,
                fontSize: 12, fontWeight: 600, color: '#374151',
              }}>
                {floor.code} — {floor.name}
              </div>

              {floor.lines.map((line) => {
                const lpos = eff('line', line.id, line.x, line.y);
                return (
                  <div
                    key={line.id}
                    style={{
                      position: 'absolute',
                      left: lpos.x, top: lpos.y,
                      width: line.w, height: line.h,
                      background: '#f3f4f6',
                      border: '1px dashed #9ca3af',
                      borderRadius: 4,
                      cursor: editMode ? 'move' : 'default',
                    }}
                    onMouseDown={(e) => onDragStart(e, 'line', line.id, lpos.x, lpos.y)}
                  >
                    <div style={{ position: 'absolute', top: 2, left: 4, fontSize: 10, color: '#6b7280' }}>
                      {line.code} — {line.name}
                    </div>

                    {line.racks.map((rack) => {
                      const rpos = eff('rack', rack.id, rack.x, rack.y);
                      const isAType = (rack.rack_type || '').toUpperCase() === 'A';
                      return (
                        <div
                          key={rack.id}
                          style={{
                            position: 'absolute',
                            left: rpos.x, top: rpos.y,
                            width: rack.w, height: rack.h,
                            background: isAType ? '#dbeafe' : '#fce7f3',
                            border: '1px solid #6b7280',
                            borderRadius: 3,
                            cursor: editMode ? 'move' : 'default',
                          }}
                          onMouseDown={(e) => onDragStart(e, 'rack', rack.id, rpos.x, rpos.y)}
                          title={`${rack.code} — ${rack.name} (${rack.rack_type || '?'})`}
                        >
                          <div style={{ position: 'absolute', top: 2, left: 4, fontSize: 9, fontWeight: 600 }}>
                            {rack.code} {rack.rack_type ? `[${rack.rack_type}]` : ''}
                          </div>
                          {rack.bins.map((bin) => (
                            <Tooltip
                              key={bin.id}
                              title={
                                <div>
                                  <div><b>{bin.code}</b> — {bin.name}</div>
                                  <div>Capacity: {formatNumber(bin.capacity)}</div>
                                  <div>Current: {formatNumber(bin.current_qty)}</div>
                                  <div>Occupancy: {bin.occ_pct}%</div>
                                </div>
                              }
                            >
                              <div
                                onClick={(e) => { e.stopPropagation(); setSelectedBin(bin); }}
                                style={{
                                  position: 'absolute',
                                  left: bin.x, top: bin.y + 18,
                                  width: bin.w, height: bin.h,
                                  background: STATUS_COLOR[bin.status] || '#e5e7eb',
                                  border: '1px solid rgba(0,0,0,0.18)',
                                  borderRadius: 2,
                                  cursor: 'pointer',
                                  fontSize: 8,
                                  color: '#1f2937',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontWeight: 600,
                                }}
                              >
                                {bin.code?.split('-').slice(-1)[0]}
                              </div>
                            </Tooltip>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <Modal
        title={selectedBin ? `Bin ${selectedBin.code}` : 'Bin'}
        open={!!selectedBin}
        onCancel={() => setSelectedBin(null)}
        footer={null}
      >
        {selectedBin && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><Text type="secondary">Name:</Text> {selectedBin.name}</div>
            <div><Text type="secondary">Capacity:</Text> {formatNumber(selectedBin.capacity)}</div>
            <div><Text type="secondary">Current qty:</Text> {formatNumber(selectedBin.current_qty)}</div>
            <div><Text type="secondary">Occupancy:</Text> {selectedBin.occ_pct}%</div>
            <Tag color={selectedBin.status === 'empty' ? 'green' : selectedBin.status === 'full' ? 'red' : 'orange'}>
              {selectedBin.status}
            </Tag>
          </Space>
        )}
      </Modal>
    </div>
  );
};

export default FloorPlan;
