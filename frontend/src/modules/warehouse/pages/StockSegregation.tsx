// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Space, message, Row, Col, Table, Card, Descriptions,
  Divider, Typography, Tooltip, Tag, Badge, Progress, Alert, Input, InputNumber, Select,
  Popconfirm, Empty,
} from 'antd';
import {
  EyeOutlined, CheckOutlined, EnvironmentOutlined,
  AimOutlined, InboxOutlined, ReloadOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import { formatNumber, formatDateTime, getErrorMessage } from '../utils/helpers';

const { Text } = Typography;

const SEGREGATABLE_STATUSES = [
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
];

const ITEM_STATUSES = {
  pending: { color: '#fa8c16', label: 'Pending Bin' },
  in_progress: { color: '#eb2f96', label: 'In Progress' },
  done: { color: '#52c41a', label: 'Segregated' },
  skipped: { color: '#8c8c8c', label: 'Skipped' },
};

/**
 * StockSegregation
 * --------------------------------------------------------------
 * Post-putaway step: assigns received stock to specific bins
 * within a warehouse. Wraps the existing PutawayOrder data model
 * but focuses on the per-line "confirm with bin" action.
 *
 * Backend contract (from Team A audit):
 *   PUT /warehouse/putaway/{putaway_id}/items/{item_id}/confirm
 *   body: { actual_bin_id: int, status: "done" }
 *
 * Lists pending putaway orders (i.e. those still awaiting bin
 * assignment), drills into items, and lets the user enter a bin
 * code per line, then confirms.
 */
const StockSegregation = () => {
  // List filters
  const [filterStatus, setFilterStatus] = useState('pending');
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [warehouses, setWarehouses] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Drawer state
  const [viewDrawerOpen, setViewDrawerOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [items, setItems] = useState([]);
  const [confirmingKey, setConfirmingKey] = useState(null);

  // ---------------- Warehouses lookup ----------------
  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setWarehouses(
        list.map((w) => ({ label: w.name || w.warehouse_name, value: w.id }))
      );
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadWarehouses();
  }, [loadWarehouses]);

  // ---------------- List fetch ----------------
  const fetchPutaways = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      return await api.get('/warehouse/putaways', { params: qp });
    },
    [filterStatus, filterWarehouse]
  );

  // ---------------- Drawer / detail ----------------
  const handleView = async (record) => {
    setViewLoading(true);
    setViewDrawerOpen(true);
    try {
      const res = await api.get(`/warehouse/putaways/${record.id}`);
      const data = res.data;
      setViewData(data);
      const rows = (data.items || []).map((it, idx) => ({
        key: it.id || `r-${idx}`,
        id: it.id,
        item_id: it.item_id,
        item_name: it.item_name || '',
        item_code: it.item_code || '',
        qty: it.qty || it.quantity || 0,
        uom_name: it.uom_name || it.uom || '',
        batch_number: it.batch_number || '',
        suggested_bin: it.suggested_bin || '',
        suggested_bin_id: it.suggested_bin_id || null,
        actual_bin_input: it.actual_bin || it.suggested_bin || '',
        actual_bin_id: it.actual_bin_id || it.suggested_bin_id || null,
        status: it.status || 'pending',
      }));
      setItems(rows);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewDrawerOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  const closeDrawer = () => {
    setViewDrawerOpen(false);
    setViewData(null);
    setItems([]);
    setConfirmingKey(null);
  };

  // ---------------- Per-line bin edit + confirm ----------------
  const updateRow = (key, field, value) => {
    setItems((prev) =>
      prev.map((r) => (r.key === key ? { ...r, [field]: value } : r))
    );
  };

  const handleConfirm = async (row) => {
    if (!viewData) return;

    const binVal = String(row.actual_bin_input || row.actual_bin_id || '').trim();
    if (!binVal) {
      message.error('Enter a bin code or name before confirming');
      return;
    }

    setConfirmingKey(row.key);
    try {
      await api.put(
        `/warehouse/putaway/${viewData.id}/items/${row.id}/confirm`,
        { actual_bin_id: binVal, status: 'done' }
      );
      message.success(`Segregated ${row.item_name || row.item_code} to bin "${binVal}"`);
      // optimistic update
      setItems((prev) =>
        prev.map((r) =>
          r.key === row.key
            ? { ...r, status: 'done', actual_bin_input: binVal, actual_bin_id: binVal }
            : r
        )
      );
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setConfirmingKey(null);
    }
  };

  // ---------------- Progress ----------------
  const progressPct = (() => {
    if (!items.length) return 0;
    const done = items.filter((r) => r.status === 'done' || r.status === 'skipped').length;
    return Math.round((done / items.length) * 100);
  })();

  // ---------------- Item table columns ----------------
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, i) => i + 1 },
    {
      title: 'Item', dataIndex: 'item_name', width: 220, ellipsis: true,
      render: (v, r) => (
        <Tooltip title={`${r.item_code || ''} - ${v}`}>
          <Text ellipsis style={{ maxWidth: 200 }}>{v || r.item_code || `#${r.item_id}`}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 90, align: 'right',
      render: (v, r) => (
        <Text strong>
          {formatNumber(v)} {r.uom_name && <Text type="secondary" style={{ fontSize: 12 }}>{r.uom_name}</Text>}
        </Text>
      ),
    },
    {
      title: 'Batch', dataIndex: 'batch_number', width: 110,
      render: (v) => v || '-',
    },
    {
      title: 'Suggested Bin', dataIndex: 'suggested_bin', width: 140,
      render: (v, r) => v ? (
        <Tag icon={<AimOutlined />} color="blue">{v}</Tag>
      ) : r.suggested_bin_id ? (
        <Tag color="blue">#{r.suggested_bin_id}</Tag>
      ) : (
        <Text type="secondary">-</Text>
      ),
    },
    {
      title: 'Bin / Location',
      width: 220,
      render: (_, r) => {
        if (r.status === 'done') {
          return (
            <Tag icon={<EnvironmentOutlined />} color="green">
              Bin: {r.actual_bin_input || r.actual_bin_id || r.suggested_bin || r.suggested_bin_id}
            </Tag>
          );
        }
        if (r.status === 'skipped') {
          return <Tag color="default">Skipped</Tag>;
        }
        return (
          <Input
            placeholder="Bin code"
            size="small"
            style={{ width: '100%' }}
            value={r.actual_bin_input || ''}
            onChange={(e) => {
              const v = e.target.value;
              updateRow(r.key, 'actual_bin_input', v);
              updateRow(r.key, 'actual_bin_id', v);
            }}
            onPressEnter={() => handleConfirm(r)}
          />
        );
      },
    },
    {
      title: 'Status', dataIndex: 'status', width: 130,
      render: (v) => {
        const cfg = ITEM_STATUSES[v] || ITEM_STATUSES.pending;
        return (
          <Tag style={{ color: '#fff', backgroundColor: cfg.color, borderColor: cfg.color }}>
            {cfg.label}
          </Tag>
        );
      },
    },
    {
      title: 'Action', width: 130, fixed: 'right',
      render: (_, r) => {
        if (r.status === 'done') {
          return <Tag color="success" icon={<CheckOutlined />}>Done</Tag>;
        }
        if (r.status === 'skipped') {
          return <Tag color="default">Skipped</Tag>;
        }
        return (
          <Popconfirm
            title="Assign this stock to the bin?"
            description={`Confirm putaway of ${r.item_name || 'item'} to bin "${r.actual_bin_input || r.actual_bin_id || '?'}"`}
            onConfirm={() => handleConfirm(r)}
            okText="Confirm"
          >
            <Button
              type="primary"
              size="small"
              icon={<CheckOutlined />}
              loading={confirmingKey === r.key}
              ghost
            >
              Confirm Bin
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  // ---------------- List columns ----------------
  const columns = [
    {
      title: 'Putaway #', dataIndex: 'putaway_number', width: 160, fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    { title: 'GRN', dataIndex: 'grn_number', width: 150, render: (v) => v || '-' },
    { title: 'Warehouse', dataIndex: 'warehouse_name', width: 160, ellipsis: true, render: (v) => v || '-' },
    {
      title: 'Status', dataIndex: 'status', width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Progress', width: 140,
      render: (_, r) => {
        const total = r.total_items || 0;
        const done = r.completed_items || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return <Progress percent={pct} size="small" format={() => `${done}/${total}`} />;
      },
    },
    {
      title: 'Created', dataIndex: 'created_at', width: 150,
      render: (v) => v ? formatDateTime(v) : '-',
    },
    {
      title: 'Action', width: 130, fixed: 'right',
      render: (_, record) => (
        <Tooltip title="Open segregation panel">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)}>
            Segregate
          </Button>
        </Tooltip>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={SEGREGATABLE_STATUSES}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 180 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
      />
      <Button
        icon={<ReloadOutlined />}
        onClick={() => setRefreshKey((k) => k + 1)}
      >
        Refresh
      </Button>
    </Space>
  );

  return (
    <div>
      <PageHeader
        title="Stock Segregation"
        subtitle="Assign received goods to specific bins / locations within the warehouse"
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="What is this?"
        description={
          <span>
            After putaway is created, each received line must be segregated into a
            specific <b>bin</b>. Open a putaway, enter a bin id (or code) for each
            pending line, then click <b>Confirm Bin</b> to commit it to stock.
          </span>
        }
      />

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPutaways}
        rowKey="id"
        searchPlaceholder="Search by putaway number or GRN..."
        exportFileName="stock_segregation"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />

      <Drawer
        title={viewData ? `Segregate: ${viewData.putaway_number}` : 'Stock Segregation'}
        width={1050}
        open={viewDrawerOpen}
        onClose={closeDrawer}
        destroyOnHidden
        loading={viewLoading}
        extra={
          <Space>
            <Button onClick={closeDrawer}>Close</Button>
          </Space>
        }
      >
        {viewData && (
          <>
            <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Putaway">{viewData.putaway_number}</Descriptions.Item>
              <Descriptions.Item label="GRN">{viewData.grn_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Assigned To">{viewData.assigned_to_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created">
                {viewData.created_at ? formatDateTime(viewData.created_at) : '-'}
              </Descriptions.Item>
            </Descriptions>

            <Card size="small" style={{ marginBottom: 16 }}>
              <Row align="middle" gutter={16}>
                <Col span={4}><Text strong>Progress</Text></Col>
                <Col span={14}>
                  <Progress
                    percent={progressPct}
                    status={progressPct === 100 ? 'success' : 'active'}
                    strokeColor={{ '0%': '#eb2f96', '100%': '#52c41a' }}
                  />
                </Col>
                <Col span={6} style={{ textAlign: 'right' }}>
                  <Space>
                    <Badge status="success" text={`Done: ${items.filter((i) => i.status === 'done').length}`} />
                    <Badge status="processing" text={`Pending: ${items.filter((i) => i.status === 'pending' || i.status === 'in_progress').length}`} />
                  </Space>
                </Col>
              </Row>
            </Card>

            <Divider orientation="left">
              <Space>
                <InboxOutlined />
                Lines to Segregate
                <Badge count={items.length} style={{ backgroundColor: '#eb2f96' }} />
              </Space>
            </Divider>

            {items.length === 0 ? (
              <Empty description="No items on this putaway" />
            ) : (
              <Table
                dataSource={items}
                columns={itemColumns}
                rowKey="key"
                pagination={false}
                size="small"
                scroll={{ x: 1100 }}
                rowClassName={(r) => (r.status === 'done' ? 'row-done' : '')}
              />
            )}
          </>
        )}
      </Drawer>
    </div>
  );
};

export default StockSegregation;

