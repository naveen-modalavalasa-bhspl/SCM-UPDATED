// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, Row, Col, Table, Card, Descriptions, Divider, Typography, Tag, Badge, App, Spin, Tooltip
} from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  CheckOutlined, MinusCircleOutlined, InboxOutlined, SaveOutlined,
  FileDoneOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../components/PageHeader';
import StatusTag from '../components/StatusTag';
import ItemSelector from '../components/ItemSelector';
import api from '../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI,
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const PurchaseReturnForm = () => {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [recordData, setRecordData] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Form states
  const [returnItems, setReturnItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [grnOptions, setGrnOptions] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);

  // --- Item Row Helpers ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    uom_id: null,
    qty: 0,
    rate: 0,
    amount: 0,
    reason: '',
  });

  const recalcItem = (item) => {
    item.amount = Number(((item.qty || 0) * (item.rate || 0)).toFixed(2));
    return item;
  };

  const updateReturnItem = (key, field, value) => {
    setReturnItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        return recalcItem(updated);
      })
    );
  };

  const addItemRow = () => {
    setReturnItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeItemRow = (key) => {
    setReturnItems((prev) => prev.filter((i) => i.key !== key));
  };

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes, uomRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({
          label: `[${v.vendor_code}] ${v.name}`,
          value: v.id,
          vendor: v,
        })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        setUomOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.name || i.uom_name || i.code,
            value: i.id,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  const loadPOOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/purchase-orders', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPoOptions(
        items.map((po) => ({
          label: `${po.po_number} - ${po.vendor_name || ''}`,
          value: po.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  const loadGRNOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/warehouse/grn', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setGrnOptions(
        items.map((g) => ({
          label: `${g.grn_number} - ${g.vendor_name || ''}`,
          value: g.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // --- Fetch existing record ---
  const fetchRecord = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/purchase-returns/${id}`);
      const data = res.data;
      setRecordData(data);
      form.setFieldsValue({
        vendor_id: data.vendor_id,
        warehouse_id: data.warehouse_id,
        po_id: data.po_id,
        grn_id: data.grn_id,
        return_date: data.return_date ? dayjs(data.return_date) : null,
        reason: data.reason,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        uom_id: item.uom_id,
        qty: Number(item.qty || 0),
        rate: Number(item.rate || 0),
        amount: Number(item.amount || 0),
        reason: item.reason || '',
      }));
      setReturnItems(items.length > 0 ? items : [createEmptyItem()]);

      // If query param edit=true is passed, activate edit mode
      const queryParams = new URLSearchParams(location.search);
      if (queryParams.get('edit') === 'true' && data.status === 'draft') {
        setEditMode(true);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/warehouse/purchase-returns');
    } finally {
      setLoading(false);
    }
  }, [id, form, location.search, navigate, message]);

  // Init
  useEffect(() => {
    loadLookups();
    loadPOOptions();
    loadGRNOptions();
    if (!isNew) {
      fetchRecord();
    } else {
      form.setFieldsValue({
        return_date: dayjs(),
      });
      setReturnItems([createEmptyItem()]);
    }
  }, [id, isNew, fetchRecord, loadLookups, loadPOOptions, loadGRNOptions, form]);

  // --- Totals ---
  const calcTotalQty = () => returnItems.reduce((s, i) => s + (i.qty || 0), 0);
  const calcTotalAmount = () => returnItems.reduce((s, i) => s + (i.amount || 0), 0);

  // --- Actions ---
  const handleApprove = async () => {
    try {
      await api.post(`/warehouse/purchase-returns/${id}/approve`);
      message.success('Purchase Return approved');
      fetchRecord();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleComplete = async () => {
    try {
      await api.post(`/warehouse/purchase-returns/${id}/complete`);
      message.success('Purchase Return completed');
      fetchRecord();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/warehouse/purchase-returns/${id}`);
      message.success('Purchase Return deleted');
      navigate('/warehouse/purchase-returns');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = returnItems.filter((i) => i.item_id && i.qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with quantity');
        return;
      }
      setSubmitting(true);

      const payload = {
        ...values,
        return_date: formatDateForAPI(values.return_date),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id,
          rate: item.rate,
          reason: item.reason || '',
        })),
      };

      if (!isNew) {
        await api.put(`/warehouse/purchase-returns/${id}`, payload);
        message.success('Purchase Return updated successfully');
        setEditMode(false);
        fetchRecord();
      } else {
        const res = await api.post('/warehouse/purchase-returns', payload);
        message.success('Purchase Return created successfully');
        const newId = res.data?.id;
        if (newId) {
          navigate(`/warehouse/purchase-returns/${newId}`);
        } else {
          navigate('/warehouse/purchase-returns');
        }
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  // --- VIEW MODE (existing return) ---
  if (!isNew && recordData && !editMode) {
    const viewItemColumns = [
      { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
      { title: 'Item', dataIndex: 'item_name', width: 200, ellipsis: true, render: (v, r) => v || r.item_code || '-' },
      { title: 'Qty', dataIndex: 'qty', width: 90, align: 'right', render: (v) => formatNumber(v) },
      { title: 'UOM', dataIndex: 'uom_name', width: 80, render: (v) => v || '-' },
      { title: 'Rate', dataIndex: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
      { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
      { title: 'Reason', dataIndex: 'reason', width: 200, ellipsis: true, render: (v) => v || '-' },
    ];

    return (
      <div>
        <PageHeader
          title={recordData.return_number || `Return #${id}`}
          subtitle="Purchase Return Details"
        >
          <Space>
            {recordData.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)} type="primary">
                  Edit
                </Button>
                <Popconfirm title="Approve this Purchase Return?" onConfirm={handleApprove}>
                  <Button type="default" icon={<CheckOutlined />} style={{ color: '#52c41a' }}>Approve</Button>
                </Popconfirm>
                <Popconfirm title="Delete this Purchase Return?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
                  <Button danger icon={<DeleteOutlined />}>Delete</Button>
                </Popconfirm>
              </>
            )}
            {(recordData.status === 'approved' || recordData.status === 'dispatched') && (
              <Popconfirm title="Mark this Purchase Return as completed?" onConfirm={handleComplete}>
                <Button type="primary" icon={<FileDoneOutlined />}>Complete</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/warehouse/purchase-returns')}>
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Return Number">{recordData.return_number}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={recordData.status} /></Descriptions.Item>
            <Descriptions.Item label="Return Date">{formatDate(recordData.return_date)}</Descriptions.Item>
            <Descriptions.Item label="Vendor">{recordData.vendor_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{recordData.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="PO Reference">{recordData.po_number || recordData.po_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="GRN Reference">{recordData.grn_number || recordData.grn_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="Reason" span={2}>{recordData.reason || '-'}</Descriptions.Item>
            <Descriptions.Item label="Total Amount"><Text strong>{formatCurrency(recordData.total_amount)}</Text></Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Return Items">
          <Table
            dataSource={recordData.items || []}
            columns={viewItemColumns}
            rowKey="id"
            pagination={false}
            size="small"
            scroll={{ x: 800 }}
          />
        </Card>
      </div>
    );
  }

  // --- EDIT / CREATE MODE ---
  const returnItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (val, record) =>
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateReturnItem(record.key, 'item_id', itemId);
              if (item) {
                updateReturnItem(record.key, 'item_name', item.item_name || item.name || '');
                updateReturnItem(record.key, 'item_code', item.item_code || item.code || '');
                const rate = parseFloat(item.last_purchase_rate || item.purchase_price || 0);
                if (rate > 0) updateReturnItem(record.key, 'rate', rate);
                updateReturnItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
                if (!record.reason) updateReturnItem(record.key, 'reason', 'Quality issue');
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateReturnItem(record.key, 'qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 110,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateReturnItem(record.key, 'uom_id', v)}
          options={uomOptions}
          placeholder="UOM"
          size="small"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 100,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateReturnItem(record.key, 'rate', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 110, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: 'Reason', dataIndex: 'reason', width: 160,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateReturnItem(record.key, 'reason', e.target.value)}
          size="small"
          placeholder="Reason"
        />
      ),
    },
    {
      title: '', width: 35,
      render: (_, record) =>
        returnItems.length > 1 ? (
          <MinusCircleOutlined
            style={{ color: '#ff4d4f', cursor: 'pointer' }}
            onClick={() => removeItemRow(record.key)}
          />
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Purchase Return' : `Edit Purchase Return`}
        subtitle="Manage purchase return request details"
      >
        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSubmit}
            loading={submitting}
          >
            Save
          </Button>
          <Button
            onClick={() => {
              if (isNew) {
                navigate('/warehouse/purchase-returns');
              } else {
                setEditMode(false);
              }
            }}
          >
            Cancel
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="return_date" label="Return Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="po_id" label="Purchase Order">
                <Select
                  options={poOptions}
                  placeholder="Select PO (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onSearch={(v) => loadPOOptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="grn_id" label="GRN">
                <Select
                  options={grnOptions}
                  placeholder="Select GRN (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onSearch={(v) => loadGRNOptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="reason" label="Reason">
                <Input placeholder="Return reason" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Card title="Return Items">
        <Table
          dataSource={returnItems}
          columns={returnItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 380 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Total Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text strong>{formatNumber(calcTotalQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
              <Col span={14}><Text strong style={{ fontSize: 16 }}>Total Amount:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}>
                <Text strong style={{ fontSize: 16, color: '#eb2f96' }}>{formatCurrency(calcTotalAmount())}</Text>
              </Col>
            </Row>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default PurchaseReturnForm;
