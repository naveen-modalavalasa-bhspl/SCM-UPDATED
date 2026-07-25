// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Select, Space, Tag, Statistic, Row, Col, Typography, Button, message, Modal } from 'antd';
import { ReloadOutlined, SaveOutlined, EditOutlined, CloseOutlined } from '@ant-design/icons';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import PageHeader from '../components/PageHeader';
import api from '../config/api';
import { formatNumber, getErrorMessage } from '../utils/helpers';
import useAuthStore from '../store/authStore';

const { Text } = Typography;

const STATUS_HEX = {
  empty: '#86efac',
  partial: '#fbbf24',
  full: '#ef4444',
};

const FLOOR_THICKNESS = 4;
const FLOOR_GAP = 60;
const RACK_DEPTH = 28;
const SCALE = 0.05;

const floorY = (idx) => idx * (FLOOR_THICKNESS + FLOOR_GAP);

const Bin = ({ bin, parentX, parentZ, baseY, isSelected, onPick }) => {
  const w = (bin.w || 36) * SCALE;
  const h = (bin.h || 24) * SCALE;
  const d = RACK_DEPTH * SCALE * 0.6;
  const x = parentX + (bin.x || 0) * SCALE + w / 2;
  const z = parentZ;
  const y = baseY + (bin.y || 0) * SCALE + h / 2;
  const color = STATUS_HEX[bin.status] || '#cbd5e1';
  return (
    <mesh
      position={[x, y, z]}
      onClick={(e) => { e.stopPropagation(); onPick && onPick(bin); }}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = 'default'; }}
    >
      <boxGeometry args={[w * 0.95, h * 0.85, d]} />
      <meshStandardMaterial color={color} emissive={isSelected ? '#1d4ed8' : '#000'} emissiveIntensity={isSelected ? 0.6 : 0} />
    </mesh>
  );
};

const Rack = ({ rack, baseY, floorIdx, isAType, x, z, yOffset, draggingEnabled, onBinPick, selectedBinId, onDragRack, onDragEndRack }) => {
  const w = (rack.w || 200) * SCALE;
  const h = (rack.h || 100) * SCALE + 1;
  const d = RACK_DEPTH * SCALE;
  const cx = x * SCALE + w / 2;
  const cz = -z * SCALE - d / 2;
  const cy = baseY + h / 2 + (yOffset || 0);

  const dragRef = useRef(null);

  const onDown = (e) => {
    if (!draggingEnabled) return;
    e.stopPropagation();
    dragRef.current = {
      startPoint: e.point.clone(),
      startX: x,
      startZ: z,
      startFloor: floorIdx,
      startY: e.point.y,
    };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    const dx = (e.point.x - dragRef.current.startPoint.x) / SCALE;
    const dz = (dragRef.current.startPoint.z - e.point.z) / SCALE;
    const dy = e.point.y - dragRef.current.startY;
    onDragRack && onDragRack(rack.id, dragRef.current.startX + dx, dragRef.current.startZ + dz, dy);
  };
  const onUp = (e) => {
    if (!dragRef.current) return;
    onDragEndRack && onDragEndRack(rack.id, dragRef.current.startFloor);
    dragRef.current = null;
    try { e.target.releasePointerCapture(e.pointerId); } catch {}
  };

  return (
    <group>
      <mesh
        position={[cx, cy, cz]}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={isAType ? '#bfdbfe' : '#fbcfe8'} transparent opacity={0.45} />
      </mesh>
      {(rack.bins || []).map((bin) => (
        <Bin
          key={bin.id}
          bin={bin}
          parentX={x * SCALE}
          parentZ={-z * SCALE - d / 2}
          baseY={baseY + 0.5}
          isSelected={Number(bin.id) === Number(selectedBinId)}
          onPick={onBinPick}
        />
      ))}
      <Html position={[cx, cy + h / 2 + 0.5, cz]} center distanceFactor={32} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{
          background: 'rgba(255,255,255,0.85)',
          padding: '1px 4px',
          borderRadius: 3,
          fontSize: 9,
          fontWeight: 600,
          color: '#111827',
          whiteSpace: 'nowrap',
        }}>
          {rack.code}{rack.rack_type ? ` [${rack.rack_type}]` : ''}
        </div>
      </Html>
    </group>
  );
};

const FloorSlab = ({ floor, idx, draggingEnabled, onBinPick, selectedBinId, onDragRack, onDragEndRack, layoutOverrides }) => {
  const baseY = floorY(idx);
  const racks = useMemo(() => (floor.lines || []).flatMap((l) => l.racks || []), [floor]);

  // Auto-pack racks into rows. Reads override if provided, otherwise computes a default
  // packed position (does not mutate the input). Returns { rack, x, z } for each.
  const packed = useMemo(() => {
    const out = [];
    let cursorX = 20;
    let cursorZ = 20;
    let rowH = 0;
    const ROW_WRAP_W = 1100;
    for (const r of racks) {
      const ovr = layoutOverrides?.[`rack-${r.id}`];
      let rx = ovr ? ovr.x : (r.layout_x ?? null);
      let rz = ovr ? ovr.y : (r.layout_y ?? null);
      if (rx == null || rz == null) {
        rx = cursorX;
        rz = cursorZ;
        cursorX = rx + (r.w || 200) + 18;
        rowH = Math.max(rowH, RACK_DEPTH);
        if (cursorX > ROW_WRAP_W) {
          cursorX = 20;
          cursorZ += rowH + 30;
          rowH = 0;
        }
      }
      out.push({ rack: r, x: rx, z: rz });
    }
    return out;
  }, [racks, layoutOverrides]);

  const slabW = useMemo(() => Math.max(80, ...packed.map(p => (p.x + (p.rack.w || 200)))) * SCALE + 4, [packed]);
  const slabD = useMemo(() => Math.max(60, ...packed.map(p => (p.z + RACK_DEPTH))) * SCALE + 4, [packed]);

  return (
    <group>
      <mesh position={[slabW / 2, baseY - FLOOR_THICKNESS / 2, -slabD / 2]}>
        <boxGeometry args={[slabW, FLOOR_THICKNESS, slabD]} />
        <meshStandardMaterial color="#e5e7eb" />
      </mesh>
      <Html position={[2, baseY + 1, 4]} center={false} distanceFactor={50} style={{ pointerEvents: 'none' }}>
        <div style={{
          background: 'rgba(31,41,55,0.85)',
          color: '#fff',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}>
          {floor.code} — {floor.name}
        </div>
      </Html>
      {packed.map(({ rack, x, z }) => {
        const ovr = layoutOverrides?.[`rack-${rack.id}`];
        const yOffset = ovr?.dy || 0;
        return (
          <Rack
            key={rack.id}
            rack={rack}
            baseY={baseY}
            floorIdx={idx}
            isAType={(rack.rack_type || '').toUpperCase() === 'A'}
            x={x}
            z={z}
            yOffset={yOffset}
            draggingEnabled={draggingEnabled}
            onBinPick={onBinPick}
            selectedBinId={selectedBinId}
            onDragRack={onDragRack}
            onDragEndRack={onDragEndRack}
          />
        );
      })}
    </group>
  );
};

const Scene = ({ plan, draggingEnabled, onBinPick, selectedBinId, onDragRack, onDragEndRack, layoutOverrides }) => {
  if (!plan?.floors?.length) return null;
  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[40, 60, 30]} intensity={0.7} />
      <directionalLight position={[-30, 40, -20]} intensity={0.3} />
      <gridHelper args={[400, 40, '#cbd5e1', '#e5e7eb']} position={[0, -1, 0]} />
      {plan.floors.map((floor, i) => (
        <FloorSlab
          key={floor.id}
          floor={floor}
          idx={i}
          draggingEnabled={draggingEnabled}
          onBinPick={onBinPick}
          selectedBinId={selectedBinId}
          onDragRack={onDragRack}
          onDragEndRack={onDragEndRack}
          layoutOverrides={layoutOverrides}
        />
      ))}
      <OrbitControls makeDefault enablePan enableZoom enableRotate target={[20, 20, -20]} />
    </>
  );
};

const FloorPlan3D = () => {
  const userRoleCodes = useAuthStore((s) => s.user?.role_codes || []);
  const canEdit = userRoleCodes.some((r) => ['super_admin', 'admin', 'warehouse_manager'].includes(r));
  const [searchParams] = useSearchParams();
  const initialWh = searchParams.get('warehouse_id');

  const [warehouses, setWarehouses] = useState([]);
  const [warehouseId, setWarehouseId] = useState(initialWh ? Number(initialWh) : undefined);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [overrides, setOverrides] = useState({});
  const [selectedBin, setSelectedBin] = useState(null);

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

  const onDragRack = useCallback((rackId, newX, newZ, dy) => {
    setOverrides((prev) => ({
      ...prev,
      [`rack-${rackId}`]: { ...(prev[`rack-${rackId}`] || {}), x: newX, y: newZ, dy: dy || 0 },
    }));
  }, []);

  // On pointer up: snap rack to nearest floor by Y position.
  // If it landed on a different floor, set new line_id (first line on the
  // target floor) so the rack reparents on save.
  const onDragEndRack = useCallback((rackId, originalFloorIdx) => {
    const floors = plan?.floors || [];
    if (!floors.length) return;
    setOverrides((prev) => {
      const cur = prev[`rack-${rackId}`];
      if (!cur) return prev;
      const dy = cur.dy || 0;
      // Each floor sits at y = i * (FLOOR_THICKNESS + FLOOR_GAP). The rack
      // has been dragged with dy world units; figure out which floor it now
      // sits on (snap to the nearest floor).
      const targetFloorIdx = Math.max(0, Math.min(
        floors.length - 1,
        Math.round(originalFloorIdx + dy / (FLOOR_THICKNESS + FLOOR_GAP))
      ));
      if (targetFloorIdx === originalFloorIdx) {
        return { ...prev, [`rack-${rackId}`]: { ...cur, dy: 0 } };
      }
      const targetFloor = floors[targetFloorIdx];
      // Pick the first line on the target floor. (Operator can refine via
      // Masters → Warehouses if they want a specific aisle.)
      const newLine = targetFloor?.lines?.[0];
      const newLineId = newLine?.id || null;
      return {
        ...prev,
        [`rack-${rackId}`]: {
          ...cur,
          dy: 0,
          line_id: newLineId,
          target_floor_idx: targetFloorIdx,
        },
      };
    });
  }, [plan]);

  const saveLayout = async () => {
    const items = Object.entries(overrides).map(([k, v]) => {
      const [type, idStr] = k.split('-');
      const item = { type, id: Number(idStr), x: v.x, y: v.y };
      if (v.line_id) item.line_id = v.line_id;
      return item;
    });
    if (!items.length) {
      setEditMode(false);
      return;
    }
    try {
      await api.put(`/warehouse/floor-plan/${warehouseId}/layout`, { items });
      message.success(`Saved ${items.length} rack position(s)`);
      setOverrides({});
      setEditMode(false);
      fetchPlan();
    } catch (e) {
      message.error(getErrorMessage(e));
    }
  };

  const cancelEdit = () => { setOverrides({}); setEditMode(false); };

  const totalBins = plan?.stats?.bins || 0;
  const occupied = plan?.stats?.occupied_bins || 0;

  return (
    <div>
      <PageHeader
        title="Warehouse 3D View"
        subtitle="WebGL 3D — drag to orbit, right-click drag to pan, scroll to zoom. Edit Mode lets you drag racks across a floor."
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
            <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit Racks</Button>
          )}
          {editMode && (
            <>
              <Button icon={<SaveOutlined />} type="primary" onClick={saveLayout}>Save</Button>
              <Button icon={<CloseOutlined />} onClick={cancelEdit}>Cancel</Button>
            </>
          )}
        </Space>
      </PageHeader>

      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={5}><Card size="small"><Statistic title="Floors" value={plan?.stats?.floors || 0} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="Racks" value={plan?.stats?.racks || 0} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="Bins" value={totalBins} /></Card></Col>
        <Col span={5}><Card size="small"><Statistic title="Occupied" value={`${occupied}/${totalBins}`} /></Card></Col>
        <Col span={4}><Card size="small">
          <Space size={4}>
            <Tag color="green">Empty</Tag><Tag color="orange">Partial</Tag><Tag color="red">Full</Tag>
          </Space>
        </Card></Col>
      </Row>

      <div style={{
        height: 720,
        background: 'linear-gradient(#dbeafe, #f8fafc)',
        border: '1px solid #cbd5e1',
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative',
      }}>
        {!loading && !plan?.floors?.length && (
          <div style={{ padding: 60, textAlign: 'center', color: '#6b7280' }}>
            No layout to render — pick a warehouse with floors / racks defined.
          </div>
        )}
        {plan?.floors?.length > 0 && (
          <Canvas camera={{ position: [80, 100, 130], fov: 45, near: 0.1, far: 4000 }}>
            <Suspense fallback={null}>
              <Scene
                plan={plan}
                draggingEnabled={editMode}
                onBinPick={(bin) => setSelectedBin(bin)}
                selectedBinId={selectedBin?.id}
                onDragRack={onDragRack}
                onDragEndRack={onDragEndRack}
                layoutOverrides={overrides}
              />
            </Suspense>
          </Canvas>
        )}
        {editMode && (
          <div style={{
            position: 'absolute', top: 12, right: 12,
            background: 'rgba(37,99,235,0.92)', color: '#fff',
            padding: '6px 12px', borderRadius: 4, fontSize: 12, fontWeight: 600,
            pointerEvents: 'none',
          }}>
            EDIT MODE — drag any rack to reposition
          </div>
        )}
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

export default FloorPlan3D;
