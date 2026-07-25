// @ts-nocheck
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Button, Card, Col, Row, Select, Space, Table, Tag, Typography,
  Empty, Spin, message, Tooltip, InputNumber, Divider, Alert, Radio,
} from 'antd';
import {
  PrinterOutlined, ReloadOutlined, ScanOutlined,
  TagsOutlined, BarcodeOutlined, QrcodeOutlined,
} from '@ant-design/icons';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../components/PageHeader';
import BarcodeDisplay from '../components/BarcodeDisplay';
import api from '../config/api';
import { formatDate, getErrorMessage } from '../utils/helpers';

const { Text } = Typography;

/**
 * OutwardLabelling
 * --------------------------------------------------------------------------
 * Generates barcode / QR labels for outbound shipments. The operator picks a
 * source document (Material Issue), then for every line item we either fetch
 * an existing BarcodeRegistry row or generate one via POST /barcode/generate.
 * Labels render client-side with <BarcodeDisplay/> (react-barcode + qrcode.react)
 * so the print preview matches what is on screen even when the backend label
 * service is unreachable. A consolidated print view is driven by react-to-print.
 *
 * Workflow note (PDF-faithful flow): items are tagged & barcoded BEFORE
 * dispatch — this page is the pre-dispatch tagging station.
 */
const OutwardLabelling = () => {
  // ---- Source selection ----
  const [sourceType, setSourceType] = useState('material_issue');
  const [miOptions, setMiOptions] = useState([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState(undefined);

  // ---- Source detail ----
  const [sourceDetail, setSourceDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ---- Per-line label state ----
  // Map keyed by line item id: { barcode_value, barcode_type, barcode_data, copies }
  const [labels, setLabels] = useState({});
  const [generating, setGenerating] = useState(false);

  // ---- Layout / format toggles (UI-only, applied to every label) ----
  const [labelFormat, setLabelFormat] = useState('auto'); // 'auto' | 'code128' | 'qr'
  const [defaultCopies, setDefaultCopies] = useState(1);

  const printRef = useRef(null);

  // ------------------------------------------------------------------ load sources
  const loadSources = useCallback(async () => {
    setSourceLoading(true);
    try {
      // BUG-LBL-001: only "issued" / "acknowledged" / "completed" MIs should
      // surface here — labelling drafts is a foot-gun because items can still
      // be re-priced or removed.
      const res = await api.get('/warehouse/material-issues', {
        params: { page_size: 100, status: 'issued' },
      });
      const data = res.data || {};
      const items = data.items || data.data || [];
      setMiOptions(
        items.map((mi) => ({
          label: `${mi.issue_number} - ${formatDate(mi.issue_date) || ''} - ${mi.department || ''}`.trim(),
          value: mi.id,
        }))
      );
    } catch (err) {
      message.error(getErrorMessage(err) || 'Failed to load material issues');
    } finally {
      setSourceLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  // ------------------------------------------------------------------ load detail
  const loadDetail = useCallback(async (id) => {
    if (!id) {
      setSourceDetail(null);
      setLabels({});
      return;
    }
    setDetailLoading(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${id}`);
      setSourceDetail(res.data || null);
      // Reset existing labels - operator must re-generate when source changes.
      setLabels({});
    } catch (err) {
      message.error(getErrorMessage(err) || 'Failed to load source detail');
      setSourceDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDetail(selectedSourceId);
  }, [selectedSourceId, loadDetail]);

  // ------------------------------------------------------------------ generate
  const generateLabelForLine = useCallback(async (line) => {
    // Use item-level entity_type so re-runs reuse the existing registry row
    // (the backend dedupes on (entity_type, entity_id, is_active=True)).
    const payload = {
      entity_type: 'item',
      entity_id: line.item_id,
      barcode_type:
        labelFormat === 'auto' ? null
          : labelFormat === 'qr' ? 'qrcode'
          : 'code128',
      item_id: line.item_id,
      batch_id: line.batch_id || null,
    };
    const res = await api.post('/barcode/generate', payload);
    return res.data;
  }, [labelFormat]);

  const handleGenerateAll = async () => {
    if (!sourceDetail || !sourceDetail.items?.length) {
      message.warning('Pick a source document with line items first');
      return;
    }
    setGenerating(true);
    const next = {};
    let okCount = 0;
    let failCount = 0;
    // Sequential so we don't blast the backend with parallel writes against
    // the same registry table - generation is cheap and order is informative
    // when surfacing the per-row error.
    for (const line of sourceDetail.items) {
      try {
        const data = await generateLabelForLine(line);
        next[line.id] = {
          barcode_value: data.barcode_value,
          barcode_type: (data.barcode_type || 'code128').toLowerCase(),
          barcode_data: data.barcode_data || {},
          reused: !!data.reused,
          copies: defaultCopies,
        };
        okCount += 1;
      } catch (err) {
        failCount += 1;
        next[line.id] = {
          error: getErrorMessage(err) || 'Generate failed',
          copies: defaultCopies,
        };
      }
    }
    setLabels(next);
    setGenerating(false);
    if (failCount === 0) {
      message.success(`Generated ${okCount} label${okCount === 1 ? '' : 's'}`);
    } else {
      message.warning(`Generated ${okCount}, failed ${failCount}`);
    }
  };

  const handleRegenerateLine = async (line) => {
    try {
      const data = await generateLabelForLine(line);
      setLabels((prev) => ({
        ...prev,
        [line.id]: {
          barcode_value: data.barcode_value,
          barcode_type: (data.barcode_type || 'code128').toLowerCase(),
          barcode_data: data.barcode_data || {},
          reused: !!data.reused,
          copies: prev[line.id]?.copies || defaultCopies,
        },
      }));
    } catch (err) {
      message.error(getErrorMessage(err) || 'Failed to generate');
    }
  };

  const setLineCopies = (lineId, val) => {
    setLabels((prev) => ({
      ...prev,
      [lineId]: { ...(prev[lineId] || {}), copies: Math.max(1, Math.min(50, Number(val || 1))) },
    }));
  };

  // ------------------------------------------------------------------ printing
  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: `OutwardLabels_${sourceDetail?.issue_number || 'batch'}`,
    pageStyle: `
      @page { size: auto; margin: 6mm; }
      @media print {
        .no-print { display: none !important; }
        .label-tile {
          page-break-inside: avoid;
          break-inside: avoid;
        }
      }
    `,
  });

  const totalLabelCount = useMemo(
    () =>
      Object.values(labels).reduce(
        (s, v) => s + (v?.barcode_value ? (v.copies || 1) : 0),
        0
      ),
    [labels]
  );

  const generatedLineCount = useMemo(
    () => Object.values(labels).filter((v) => v?.barcode_value).length,
    [labels]
  );

  // ------------------------------------------------------------------ table cols
  const columns = [
    {
      title: '#',
      dataIndex: 'idx',
      width: 50,
      render: (_, __, i) => i + 1,
    },
    {
      title: 'Item',
      key: 'item',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.item_name || `Item #${r.item_id}`}</div>
          {r.item_code && <Text type="secondary" style={{ fontSize: 12 }}>{r.item_code}</Text>}
        </div>
      ),
    },
    { title: 'Qty', dataIndex: 'qty', width: 80, align: 'right' },
    { title: 'UoM', dataIndex: 'uom_name', width: 80 },
    {
      title: 'Barcode',
      key: 'barcode',
      width: 220,
      render: (_, r) => {
        const lbl = labels[r.id];
        if (!lbl) return <Tag color="default">Not generated</Tag>;
        if (lbl.error) return <Tag color="error">{lbl.error}</Tag>;
        return (
          <Space direction="vertical" size={2}>
            <Text code style={{ fontSize: 12 }}>{lbl.barcode_value}</Text>
            <Space size={4}>
              <Tag icon={lbl.barcode_type === 'qrcode' ? <QrcodeOutlined /> : <BarcodeOutlined />}>
                {lbl.barcode_type}
              </Tag>
              {lbl.reused && <Tag color="blue">Reused</Tag>}
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Copies',
      key: 'copies',
      width: 100,
      render: (_, r) => (
        <InputNumber
          min={1}
          max={50}
          size="small"
          value={labels[r.id]?.copies ?? defaultCopies}
          onChange={(v) => setLineCopies(r.id, v)}
          disabled={!labels[r.id]?.barcode_value}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 110,
      render: (_, r) => (
        <Tooltip title="Generate / refresh barcode for this line">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => handleRegenerateLine(r)}
          >
            {labels[r.id]?.barcode_value ? 'Refresh' : 'Generate'}
          </Button>
        </Tooltip>
      ),
    },
  ];

  // ------------------------------------------------------------------ render
  return (
    <div className="outward-labelling-page">
      <PageHeader
        title="Outward Labelling"
        subtitle="Tag & barcode items before outbound dispatch"
      >
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadSources} loading={sourceLoading}>
            Reload sources
          </Button>
          <Button
            type="primary"
            icon={<TagsOutlined />}
            onClick={handleGenerateAll}
            loading={generating}
            disabled={!sourceDetail || !sourceDetail.items?.length}
          >
            Generate all
          </Button>
          <Button
            icon={<PrinterOutlined />}
            onClick={handlePrint}
            disabled={generatedLineCount === 0}
          >
            Print labels{totalLabelCount > 0 ? ` (${totalLabelCount})` : ''}
          </Button>
        </Space>
      </PageHeader>

      {/* ---- Source picker ---- */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={6}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Source</div>
            <Radio.Group
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
            >
              <Radio.Button value="material_issue">Material Issue</Radio.Button>
              {/* Picking / DO can be plugged in later - kept as visual hint
                  so the operator knows this screen will grow. */}
              <Radio.Button value="picking" disabled>Picking</Radio.Button>
            </Radio.Group>
          </Col>
          <Col xs={24} md={10}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Document</div>
            <Select
              showSearch
              allowClear
              loading={sourceLoading}
              style={{ width: '100%' }}
              placeholder="Select an issued material issue"
              optionFilterProp="label"
              options={miOptions}
              value={selectedSourceId}
              onChange={setSelectedSourceId}
            />
          </Col>
          <Col xs={12} md={4}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Format</div>
            <Select
              style={{ width: '100%' }}
              value={labelFormat}
              onChange={setLabelFormat}
              options={[
                { label: 'Auto-detect', value: 'auto' },
                { label: 'Code128', value: 'code128' },
                { label: 'QR Code', value: 'qr' },
              ]}
            />
          </Col>
          <Col xs={12} md={4}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>Default copies</div>
            <InputNumber
              min={1}
              max={50}
              value={defaultCopies}
              onChange={(v) => setDefaultCopies(Math.max(1, Math.min(50, Number(v || 1))))}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      </Card>

      {/* ---- Source detail + line items ---- */}
      <Card
        size="small"
        title={
          sourceDetail ? (
            <Space split={<Divider type="vertical" />}>
              <span><BarcodeOutlined /> {sourceDetail.issue_number}</span>
              <span>{formatDate(sourceDetail.issue_date)}</span>
              {sourceDetail.department && <span>Dept: {sourceDetail.department}</span>}
              <Tag color="processing">{sourceDetail.status}</Tag>
            </Space>
          ) : 'Line items'
        }
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : !sourceDetail ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Pick a material issue to label its line items"
          />
        ) : !sourceDetail.items?.length ? (
          <Alert type="warning" showIcon message="This document has no line items to label." />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={sourceDetail.items}
          />
        )}
      </Card>

      {/* ---- Print preview ---- */}
      {generatedLineCount > 0 && (
        <>
          <Divider orientation="left" style={{ marginTop: 24 }}>
            <ScanOutlined /> Print preview ({totalLabelCount} label{totalLabelCount === 1 ? '' : 's'})
          </Divider>
          <Card size="small">
            <div ref={printRef} className="label-print-area">
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  justifyContent: 'flex-start',
                }}
              >
                {sourceDetail.items.flatMap((line) => {
                  const lbl = labels[line.id];
                  if (!lbl?.barcode_value) return [];
                  const copies = Math.max(1, lbl.copies || 1);
                  const isQR = lbl.barcode_type === 'qrcode' || lbl.barcode_type === 'qr';
                  return Array.from({ length: copies }, (_, i) => (
                    <div
                      key={`${line.id}-${i}`}
                      className="label-tile"
                      style={{
                        width: 220,
                        border: '1px solid #d9d9d9',
                        borderRadius: 4,
                        padding: 10,
                        background: '#fff',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4, lineHeight: 1.2 }}>
                        {line.item_name || `Item #${line.item_id}`}
                      </div>
                      {line.item_code && (
                        <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>
                          {line.item_code}
                        </div>
                      )}
                      <BarcodeDisplay
                        value={lbl.barcode_value}
                        type={isQR ? 'QR' : 'CODE128'}
                        height={50}
                        qrSize={96}
                      />
                      <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>
                        Qty: {line.qty} {line.uom_name || ''}
                      </div>
                      {lbl.barcode_data?.batch_number && (
                        <div style={{ fontSize: 10, color: '#444' }}>
                          Batch: {lbl.barcode_data.batch_number}
                        </div>
                      )}
                      {lbl.barcode_data?.expiry_date && (
                        <div style={{ fontSize: 10, color: '#444' }}>
                          Exp: {String(lbl.barcode_data.expiry_date).slice(0, 10)}
                        </div>
                      )}
                      <div style={{ fontSize: 9, color: '#888', marginTop: 4 }}>
                        {sourceDetail.issue_number}
                      </div>
                    </div>
                  ));
                })}
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
};

export default OutwardLabelling;
