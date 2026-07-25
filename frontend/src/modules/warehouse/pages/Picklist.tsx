// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, MinusCircleOutlined, PrinterOutlined,
  DownloadOutlined, FileDoneOutlined, SendOutlined, InboxOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import DataTable from '../components/DataTable';
import StatusTag from '../components/StatusTag';
import ItemSelector from '../components/ItemSelector';
import api from '../config/api';
import {
  formatNumber, getErrorMessage, formatDateTime,
} from '../utils/helpers';

const { Text } = Typography;

const PICK_STATUSES = [
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Picked', value: 'picked' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const PICK_STRATEGIES = [
  { label: 'FIFO', value: 'fifo' },
  { label: 'FEFO', value: 'fefo' },
  { label: 'LIFO', value: 'lifo' },
  { label: 'Manual', value: 'manual' },
];

const Picklist = () => {
  const navigate = useNavigate();
  const [viewDrawerOpen, setViewDrawerOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const whRes = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const w = whRes.data;
      setWarehouses(
        (w.items || w.data || w || []).map((i) => ({
          label: i.name || i.warehouse_name,
          value: i.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // --- Fetch List ---
  const fetchPicklists = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      return await api.get('/outbound/picking-orders', { params: qp });
    },
    [filterStatus, filterWarehouse]
  );

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewDrawerOpen(true);
    try {
      const res = await api.get(`/outbound/picking-orders/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      // If detail endpoint doesn't exist, show list-row data
      setViewData(record);
      if (err?.response?.status !== 404) {
        message.warning(getErrorMessage(err));
      }
    } finally {
      setViewLoading(false);
    }
  };

  // --- Generate / Create ---
  const handleAdd = () => {
    navigate('/warehouse/picklist/new');
  };

  // --- Print / Download ---
  const handlePrint = () => {
    if (!viewData) return;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) {
      message.warning('Popup blocked. Allow popups to print.');
      return;
    }
    const items = viewData.items || [];
    const rows = items
      .map(
        (it, idx) => `
        <tr>
          <td>${idx + 1}</td>
          <td>${it.item_code || ''}</td>
          <td>${it.item_name || ''}</td>
          <td>${it.batch_number || '-'}</td>
          <td>${it.from_bin || it.bin_code || '-'}</td>
          <td style="text-align:right">${it.qty_to_pick ?? it.qty ?? 0}</td>
          <td>${it.uom_code || it.uom || ''}</td>
          <td>${it.status || 'pending'}</td>
        </tr>`
      )
      .join('');
    w.document.write(`
      <html><head><title>Pick List ${viewData.pick_number || ''}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #222; }
        h1 { margin: 0 0 4px 0; font-size: 20px; }
        .meta { color: #555; margin-bottom: 16px; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #999; padding: 6px 8px; }
        th { background: #f0f0f0; text-align: left; }
        .footer { margin-top: 32px; display: flex; justify-content: space-between; font-size: 12px; }
      </style></head><body>
      <h1>Pick List: ${viewData.pick_number || ''}</h1>
      <div class="meta">
        Warehouse: ${viewData.warehouse_name || '-'} &nbsp;|&nbsp;
        Strategy: ${viewData.pick_strategy || '-'} &nbsp;|&nbsp;
        Status: ${viewData.status || '-'} &nbsp;|&nbsp;
        Picker: ${viewData.picker_name || '-'} &nbsp;|&nbsp;
        Created: ${viewData.created_at || '-'}
      </div>
      <table>
        <thead><tr>
          <th>#</th><th>Item Code</th><th>Item</th><th>Batch</th>
          <th>From Bin</th><th style="text-align:right">Qty</th><th>UoM</th><th>Status</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center">No items</td></tr>'}</tbody>
      </table>
      <div class="footer">
        <div>Picker Signature: ____________________</div>
        <div>Supervisor Signature: ____________________</div>
      </div>
      <script>window.onload=function(){window.print();}</script>
      </body></html>
    `);
    w.document.close();
  };

  const handleDownload = () => {
    if (!viewData) return;
    const items = viewData.items || [];
    const headers = ['#', 'Item Code', 'Item', 'Batch', 'From Bin', 'Qty', 'UoM', 'Status'];
    const rows = items.map((it, idx) => [
      idx + 1,
      it.item_code || '',
      it.item_name || '',
      it.batch_number || '',
      it.from_bin || it.bin_code || '',
      it.qty_to_pick ?? it.qty ?? 0,
      it.uom_code || it.uom || '',
      it.status || 'pending',
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `picklist_${viewData.pick_number || viewData.id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Detail items columns ---
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    { title: 'Item Code', dataIndex: 'item_code', width: 130 },
    { title: 'Item', dataIndex: 'item_name', ellipsis: true },
    { title: 'Batch', dataIndex: 'batch_number', width: 120, render: (v) => v || '-' },
    {
      title: 'From Bin',
      dataIndex: 'from_bin',
      width: 120,
      render: (v, r) => v || r.bin_code || '-',
    },
    {
      title: 'Qty to Pick',
      dataIndex: 'qty_to_pick',
      width: 110,
      align: 'right',
      render: (v) => <Text strong>{formatNumber(v)}</Text>,
    },
    {
      title: 'Qty Picked',
      dataIndex: 'qty_picked',
      width: 110,
      align: 'right',
      render: (v) => formatNumber(v || 0),
    },
    {
      title: 'UoM',
      dataIndex: 'uom_code',
      width: 80,
      render: (v, r) => v || r.uom || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (s) => <StatusTag status={s || 'pending'} />,
    },
  ];

  // --- Create Drawer line items columns ---
  const createItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      width: 260,
      render: (_, row) => (
        <ItemSelector
          value={row.item_id}
          onChange={(val, opt) =>
            updatePickItem(row.key, {
              item_id: val,
              item_name: opt?.label || opt?.name || '',
              item_code: opt?.code || '',
              uom_id: opt?.default_uom_id || row.uom_id,
            })
          }
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Batch ID',
      width: 110,
      render: (_, row) => (
        <InputNumber
          value={row.batch_id}
          onChange={(v) => updatePickItem(row.key, { batch_id: v })}
          placeholder="optional"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'From Bin ID',
      width: 120,
      render: (_, row) => (
        <InputNumber
          value={row.from_bin_id}
          onChange={(v) => updatePickItem(row.key, { from_bin_id: v })}
          placeholder="bin id"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Qty',
      width: 100,
      render: (_, row) => (
        <InputNumber
          min={0.0001}
          value={row.qty_to_pick}
          onChange={(v) => updatePickItem(row.key, { qty_to_pick: v })}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'UoM',
      width: 130,
      render: (_, row) => (
        <Select
          options={uomOptions}
          value={row.uom_id}
          onChange={(v) => updatePickItem(row.key, { uom_id: v })}
          showSearch
          optionFilterProp="label"
          placeholder="UoM"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: '',
      width: 50,
      render: (_, row) => (
        <Button
          type="text"
          danger
          icon={<MinusCircleOutlined />}
          onClick={() => removePickItem(row.key)}
        />
      ),
    },
  ];

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Pick Number',
      dataIndex: 'pick_number',
      key: 'pick_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Wave',
      dataIndex: 'wave_number',
      key: 'wave_number',
      width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'DO Reference',
      dataIndex: 'do_number',
      key: 'do_number',
      width: 150,
      render: (v) => v || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 140,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Strategy',
      dataIndex: 'pick_strategy',
      key: 'pick_strategy',
      width: 100,
      render: (v) => <Tag color="blue">{(v || 'fifo').toUpperCase()}</Tag>,
    },
    {
      title: 'Picker',
      dataIndex: 'picker_name',
      key: 'picker_name',
      width: 140,
      render: (v, r) => v || r.assigned_to || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      sorter: true,
      render: (v) => (v ? formatDateTime(v) : '-'),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Pick List">
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => handleView(record)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  // --- Filter Toolbar ---
  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={PICK_STATUSES}
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
    </Space>
  );

  return (
    <div>
      <PageHeader title="Pick Lists" subtitle="Generate and track warehouse picking orders">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Generate Pick List
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPicklists}
        rowKey="id"
        searchPlaceholder="Search by pick number, DO, wave..."
        exportFileName="picklists"
        toolbar={toolbar}
        scroll={{ x: 1400 }}
      />


      {/* --- View Pick List Drawer --- */}
      <Drawer
        title={viewData ? `Pick List: ${viewData.pick_number || ''}` : 'Pick List Detail'}
        width={1100}
        open={viewDrawerOpen}
        onClose={() => {
          setViewDrawerOpen(false);
          setViewData(null);
        }}
        destroyOnHidden
        loading={viewLoading}
        extra={
          viewData && (
            <Space>
              <Button icon={<DownloadOutlined />} onClick={handleDownload}>
                Download CSV
              </Button>
              <Button
                type="primary"
                icon={<PrinterOutlined />}
                onClick={handlePrint}
              >
                Print Pick List
              </Button>
              <Button
                onClick={() => {
                  setViewDrawerOpen(false);
                  setViewData(null);
                }}
              >
                Close
              </Button>
            </Space>
          )
        }
      >
        {viewData && (
          <>
            <Descriptions
              bordered
              size="small"
              column={3}
              style={{ marginBottom: 16 }}
            >
              <Descriptions.Item label="Pick Number">
                {viewData.pick_number || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Status">
                <StatusTag status={viewData.status} />
              </Descriptions.Item>
              <Descriptions.Item label="Strategy">
                <Tag color="blue">
                  {(viewData.pick_strategy || 'fifo').toUpperCase()}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Warehouse">
                {viewData.warehouse_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Wave">
                {viewData.wave_number || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="DO Reference">
                {viewData.do_number || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Picker">
                {viewData.picker_name || viewData.assigned_to || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Created">
                {viewData.created_at ? formatDateTime(viewData.created_at) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Items">
                {(viewData.items || []).length}
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">
              <Space>
                <FileDoneOutlined />
                Pick Items
                <Badge
                  count={(viewData.items || []).length}
                  style={{ backgroundColor: '#eb2f96' }}
                />
              </Space>
            </Divider>

            <Table
              dataSource={viewData.items || []}
              columns={itemColumns}
              rowKey={(r) => r.id || r.item_id}
              pagination={false}
              size="small"
              scroll={{ x: 1100 }}
              locale={{ emptyText: 'No items in this pick list' }}
            />
          </>
        )}
      </Drawer>
    </div>
  );
};

export default Picklist;

