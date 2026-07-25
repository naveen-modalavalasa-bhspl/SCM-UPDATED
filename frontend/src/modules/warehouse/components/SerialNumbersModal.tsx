// @ts-nocheck
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Modal, Input, Button, Typography, Tag, Tooltip, Space } from 'antd';
import {
  BarcodeOutlined, CheckOutlined, DeleteOutlined,
  SearchOutlined, ThunderboltOutlined, CopyOutlined,
  CloseCircleFilled, CheckCircleFilled, ScanOutlined,
} from '@ant-design/icons';

const { Text } = Typography;

/* ─── tiny progress ring ─────────────────────────────────────────── */
function ProgressRing({ filled, needed, size = 52 }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const pct = needed > 0 ? Math.min(filled / needed, 1) : 0;
  const dash = pct * circ;
  const color = pct >= 1 ? '#16a34a' : pct > 0 ? '#ea580c' : '#cbd5e1';
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={5} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={5}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.4s ease, stroke 0.3s ease' }}
      />
      <text
        x="50%" y="50%"
        textAnchor="middle" dominantBaseline="central"
        style={{ transform: 'rotate(90deg)', transformOrigin: '50% 50%', fontSize: 11, fontWeight: 700, fill: color, fontFamily: 'monospace' }}
      >
        {filled}/{needed}
      </text>
    </svg>
  );
}

/* ─── single serial input row to prevent controlled lag ────────────────── */
function SerialInput({ index, initialValue, onUpdate, onDelete }) {
  const inputRef = useRef(null);
  const [hasVal, setHasVal] = useState(!!initialValue);

  useEffect(() => {
    if (inputRef.current) {
      const elem = inputRef.current.input || inputRef.current;
      if (elem) {
        elem.value = initialValue || '';
      }
      setHasVal(!!initialValue);
    }
  }, [initialValue]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{
        width: 24, height: 24, borderRadius: 6, flexShrink: 0,
        background: hasVal ? '#dcfce7' : '#f1f5f9',
        border: `1px solid ${hasVal ? '#86efac' : '#cbd5e1'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: hasVal ? '#15803d' : '#64748b', fontSize: 10, fontWeight: 700,
      }}>{index + 1}</span>
      <Input
        ref={inputRef}
        className="serial-number-input-field"
        placeholder={`Serial #${index + 1}`}
        defaultValue={initialValue || ''}
        onChange={(e) => {
          const has = !!e.target.value.trim();
          if (has !== hasVal) {
            setHasVal(has);
          }
        }}
        onBlur={(e) => onUpdate(e.target.value)}
        onPressEnter={(e) => {
          onUpdate(e.target.value);
          setTimeout(() => {
            const inputs = document.querySelectorAll('.serial-number-input-field');
            const nextInput = inputs[index + 1];
            if (nextInput) {
              nextInput.focus();
              nextInput.select();
            }
          }, 80);
        }}
        style={{ flex: 1, borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}
        suffix={
          <CheckCircleFilled 
            style={{ 
              color: '#16a34a', 
              fontSize: 12, 
              opacity: hasVal ? 1 : 0, 
              transition: 'opacity 0.2s ease',
              pointerEvents: 'none'
            }} 
          />
        }
      />
      <Button
        type="text" danger icon={<DeleteOutlined />}
        onClick={onDelete}
        style={{ flexShrink: 0 }}
      />
    </div>
  );
}

/* ─── main component ─────────────────────────────────────────────── */
const SerialNumbersModal = ({
  value = [],
  onChange,
  itemName = '',
  itemCode = '',
  quantity,
  hasSerial = false,
  readOnly = false,
  size = 'small',
  mode = 'manual',
  availableSerials = [],
  width,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);
  const [search, setSearch] = useState('');
  const [bulkInput, setBulkInput] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [justAdded, setJustAdded] = useState(new Set());
  const bulkRef = useRef(null);
  const searchRef = useRef(null);

  const needed = quantity != null ? Math.max(0, Number(quantity)) : value.length;
  const filledCount = value.filter((s) => s && s.trim()).length;
  const draftFilled = draft.filter((s) => s && s.trim()).length;
  const allFilled = needed > 0 && filledCount >= needed;

  useEffect(() => {
    if (open) {
      setDraft([...value]);
      setSearch('');
      setBulkInput('');
      setShowBulk(false);
      setJustAdded(new Set());
    }
  }, [open]);

  /* filtered available options */
  const filteredAvailable = useMemo(() => {
    const pool = availableSerials.filter(sn => !draft.includes(sn));
    if (!search.trim()) return pool;
    const q = search.toLowerCase();
    return pool.filter(sn => sn.toLowerCase().includes(q));
  }, [availableSerials, draft, search]);

  if (!hasSerial) return <Text type="secondary" style={{ fontSize: size === 'small' ? 11 : 13 }}>—</Text>;

  const handleSave = () => { onChange(draft.filter(s => s && s.trim())); setOpen(false); };
  const removeSerial = (sn) => setDraft(prev => prev.filter(s => s !== sn));
  const clearAll = () => setDraft([]);

  /* Bulk paste/scan handler */
  const applyBulk = () => {
    const incoming = bulkInput
      .split(/[\n,;\t]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const toAdd = incoming.filter(sn => !draft.includes(sn));
    setDraft(prev => [...prev, ...toAdd]);
    setJustAdded(new Set(toAdd));
    setTimeout(() => setJustAdded(new Set()), 1500);
    setBulkInput('');
    setShowBulk(false);
  };

  const toggleSerial = (sn) => {
    if (draft.includes(sn)) {
      removeSerial(sn);
    } else {
      setDraft(prev => [...prev, sn]);
      setJustAdded(new Set([sn]));
      setTimeout(() => setJustAdded(new Set()), 900);
    }
  };

  const selectAll = () => {
    const remaining = filteredAvailable.filter(sn => !draft.includes(sn));
    setDraft(prev => [...prev, ...remaining]);
    setJustAdded(new Set(remaining));
    setTimeout(() => setJustAdded(new Set()), 1200);
  };

  /* trigger chip color */
  const chipColor = allFilled ? { bg: '#f0fdf4', border: '#bbf7d0', text: '#16a34a' }
    : filledCount > 0 ? { bg: '#fffbeb', border: '#fef08a', text: '#ca8a04' }
    : { bg: '#f8fafc', border: '#e2e8f0', text: '#64748b' };

  if (readOnly) {
    if (value.length === 0) return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
    return (
      <Tooltip title={<div style={{ maxWidth: 280 }}>{value.join(' · ')}</div>} placement="top">
        <Tag color="blue" style={{ cursor: 'default', fontSize: 11, borderRadius: 6, margin: 0 }}>
          <BarcodeOutlined style={{ marginRight: 3 }} />{value.length} serial{value.length > 1 ? 's' : ''}
        </Tag>
      </Tooltip>
    );
  }

  const isOverLimit = needed > 0 && draftFilled > needed;
  const isExact = needed > 0 && draftFilled === needed;

  return (
    <>
      <Tooltip
        title={value.length > 0 ? `${filledCount} of ${needed} serial(s) selected — click to edit` : 'Click to select serial numbers'}
        placement="top"
      >
        <span
          role="button" tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') setOpen(true); }}
          style={{
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 20,
            background: chipColor.bg, border: `1.5px solid ${chipColor.border}`,
            color: chipColor.text, fontSize: size === 'small' ? 11 : 13,
            fontWeight: 600, transition: 'all 0.2s',
            userSelect: 'none',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <BarcodeOutlined />
          {value.length > 0 ? `${filledCount}/${needed} S/N` : 'Select S/N'}
          {allFilled && <CheckCircleFilled style={{ color: '#16a34a', fontSize: 12 }} />}
        </span>
      </Tooltip>

      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        width={width || 640}
        destroyOnClose
        centered
        styles={{
          header: { background: '#ffffff', borderBottom: '1px solid #e2e8f0', padding: '16px 24px', borderRadius: '12px 12px 0 0' },
          body: { background: '#f8fafc', padding: '0', maxHeight: '70vh', overflowY: 'auto' },
          footer: { background: '#ffffff', borderTop: '1px solid #e2e8f0', padding: '12px 24px', borderRadius: '0 0 12px 12px' },
          content: { padding: 0, borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' },
          mask: { backdropFilter: 'blur(3px)' },
        }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #4f46e5, #4338ca)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <BarcodeOutlined style={{ color: '#fff', fontSize: 18 }} />
            </div>
            <div>
              <div style={{ color: '#0f172a', fontWeight: 800, fontSize: 15 }}>Select Serial Numbers</div>
              {itemName && (
                <div style={{ color: '#64748b', fontSize: 12, fontWeight: 500 }}>
                  {itemName}{itemCode ? ` · ${itemCode}` : ''}
                </div>
              )}
            </div>
          </div>
        }
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Button
              type="link" danger
              onClick={clearAll} disabled={draft.length === 0}
              style={{ fontWeight: 600, padding: 0 }}
            >
              Clear All
            </Button>
            <Space>
              <Button onClick={() => setOpen(false)} style={{ borderRadius: 6 }}>
                Cancel
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handleSave}
                disabled={isOverLimit}
                style={{
                  background: isExact ? 'linear-gradient(135deg, #16a34a, #15803d)' : 'linear-gradient(135deg, #4f46e5, #4338ca)',
                  border: 'none', fontWeight: 700, borderRadius: 6,
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)'
                }}
              >
                Save Selection ({draftFilled})
              </Button>
            </Space>
          </div>
        }
      >
        {/* Stats bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '16px 24px', borderBottom: '1px solid #e2e8f0',
          background: '#ffffff',
        }}>
          <ProgressRing filled={draftFilled} needed={needed} size={54} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Required</div>
                <div style={{ color: '#0f172a', fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{needed}</div>
              </div>
              <div>
                <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Selected</div>
                <div style={{
                  fontSize: 20, fontWeight: 800, fontFamily: 'monospace',
                  color: isOverLimit ? '#ef4444' : isExact ? '#16a34a' : '#ca8a04',
                }}>{draftFilled}</div>
              </div>
              {availableSerials.length > 0 && (
                <div>
                  <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Available</div>
                  <div style={{ color: '#0284c7', fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{availableSerials.length}</div>
                </div>
              )}
            </div>
          </div>

          <Space direction="vertical" size={6}>
            <Button
              size="small" icon={<ScanOutlined />}
              onClick={() => { setShowBulk(v => !v); setTimeout(() => bulkRef.current?.focus(), 100); }}
              style={{
                background: showBulk ? '#eff6ff' : '#f1f5f9', border: '1px solid #cbd5e1',
                color: '#2563eb', fontSize: 12, borderRadius: 6, fontWeight: 600
              }}
            >
              Bulk Paste
            </Button>
          </Space>
        </div>

        {/* Bulk paste panel */}
        {showBulk && (
          <div style={{
            padding: '16px 24px', background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
          }}>
            <div style={{ color: '#475569', fontSize: 12, marginBottom: 6, fontWeight: 600 }}>
              <CopyOutlined style={{ marginRight: 6 }} />
              Paste serial numbers (separated by comma, spaces, or newline)
            </div>
            <Input.TextArea
              ref={bulkRef}
              rows={3}
              value={bulkInput}
              onChange={e => setBulkInput(e.target.value)}
              placeholder={'SN-001\nSN-002, SN-003\nSN-004'}
              style={{ background: '#ffffff', border: '1px solid #cbd5e1', color: '#0f172a', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <Button size="small" onClick={() => { setShowBulk(false); setBulkInput(''); }} style={{ borderRadius: 4 }}>
                Cancel
              </Button>
              <Button size="small" type="primary" onClick={applyBulk} disabled={!bulkInput.trim()} style={{ borderRadius: 4 }}>
                Apply Selections
              </Button>
            </div>
          </div>
        )}

        {/* Selected chips */}
        {draft.length > 0 && (
          <div style={{ padding: '14px 24px', borderBottom: '1px solid #e2e8f0', background: '#ffffff' }}>
            <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontWeight: 600 }}>
              Currently Selected
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 110, overflowY: 'auto' }}>
              {draft.map(sn => (
                <span
                  key={sn}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    background: justAdded.has(sn) ? '#dcfce7' : '#f1f5f9',
                    border: `1px solid ${justAdded.has(sn) ? '#86efac' : '#cbd5e1'}`,
                    borderRadius: 20, padding: '3px 10px',
                    color: justAdded.has(sn) ? '#16a34a' : '#334155',
                    fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
                  }}
                >
                  {sn}
                  <CloseCircleFilled
                    style={{ color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => removeSerial(sn)}
                    onMouseEnter={e => { e.target.style.color = '#ef4444'; }}
                    onMouseLeave={e => { e.target.style.color = '#94a3b8'; }}
                  />
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Available serials picker */}
        {mode === 'select' && (
          <div style={{ padding: '20px 24px' }}>
            {availableSerials.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: '#64748b' }}>
                <BarcodeOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8, color: '#94a3b8' }} />
                <div style={{ fontSize: 13, fontWeight: 600 }}>No available serials in stock</div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <Input
                    ref={searchRef}
                    prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                    placeholder="Search serial numbers..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ borderRadius: 6, flex: 1 }}
                    allowClear
                  />
                </div>

                <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, fontWeight: 600 }}>
                  Available to choose
                </div>

                {filteredAvailable.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 16, color: '#94a3b8', fontSize: 12 }}>
                    {search ? `No serials match "${search}"` : 'All available serials are already selected'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 200, overflowY: 'auto' }}>
                    {filteredAvailable.map(sn => {
                      const isSelected = draft.includes(sn);
                      const isLimitReached = !isSelected && needed > 0 && draftFilled >= needed;
                      return (
                        <span
                          key={sn}
                          onClick={() => !isLimitReached && toggleSerial(sn)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '5px 12px', borderRadius: 20, fontSize: 12,
                            fontFamily: 'monospace', fontWeight: 600, cursor: isLimitReached ? 'not-allowed' : 'pointer',
                            background: isSelected ? '#dcfce7' : '#ffffff',
                            border: `1.5px solid ${isSelected ? '#16a34a' : '#cbd5e1'}`,
                            color: isSelected ? '#15803d' : isLimitReached ? '#cbd5e1' : '#475569',
                            transition: 'all 0.15s ease',
                            opacity: isLimitReached ? 0.5 : 1,
                          }}
                        >
                          {isSelected && <CheckCircleFilled style={{ color: '#16a34a', fontSize: 11 }} />}
                          {sn}
                        </span>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Manual input mode */}
        {mode === 'manual' && (
          <div style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
              {draft.map((serial, i) => (
                <SerialInput
                  key={i}
                  index={i}
                  initialValue={serial}
                  onUpdate={(val) => {
                    const updated = [...draft];
                    updated[i] = val;
                    setDraft(updated);
                  }}
                  onDelete={() => {
                    const u = [...draft];
                    u.splice(i, 1);
                    setDraft(u);
                  }}
                />
              ))}
            </div>
            <Button
              type="dashed" icon={<CheckOutlined />} block
              onClick={() => setDraft(prev => [...prev, ''])}
              style={{ marginTop: 12, borderRadius: 6 }}
            >
              + Add Serial Number Row
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
};

export default SerialNumbersModal;
