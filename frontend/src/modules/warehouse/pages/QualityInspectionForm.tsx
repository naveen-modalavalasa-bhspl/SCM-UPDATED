// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Spin, Popconfirm, Alert, Badge,
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, CheckOutlined,
  CloseCircleOutlined, EditOutlined, ExperimentOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import StatusTag from '../components/StatusTag';
import api from '../config/api';
import {
  formatDate, formatNumber, getErrorMessage, formatDateForAPI,
  formatDateTime,
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const INSPECTION_TYPES = [
  { label: 'Full Inspection', value: 'full' },
  { label: 'Sample Inspection', value: 'sample' },
  { label: 'Visual Inspection', value: 'visual' },
  { label: 'Measurement Based', value: 'measurement' },
];

const QI_RESULT_OPTIONS = [
  { label: 'Accepted', value: 'accepted' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Hold', value: 'hold' },
];

const OVERALL_RESULT_OPTIONS = [
  { label: 'Pass', value: 'pass' },
  { label: 'Fail', value: 'fail' },
  { label: 'Partial', value: 'partial' },
];

const resultColors = {
  accepted: '#52c41a',
  pass: '#52c41a',
  rejected: '#f5222d',
  fail: '#f5222d',
  hold: '#fa8c16',
  partial: '#fa8c16',
};

const QI_STATUS_FLOW = ['draft', 'in_progress', 'completed'];

const QualityInspectionForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [qi, setQi] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Items
  const [qiItems, setQiItems] = useState([]);

  // Lookups
  const [grnOptions, setGrnOptions] = useState([]);
  const [selectedGRN, setSelectedGRN] = useState(null);
  const [loadingGRN, setLoadingGRN] = useState(false);

  // Overall result (auto-calculated)
  const [overallResult, setOverallResult] = useState(null);

  // --- Load GRN options ---
  const loadGRNOptions = useCallback(async (search = '') => {
    try {
      // Bug fix BUG_0062/0082: include both pending_qi and qi_in_progress AND
      // include draft so newly-created GRNs (which haven't been transitioned)
      // also show up. Otherwise users create a GRN, walk to QI, and find nothing.
      const res = await api.get('/warehouse/grn', {
        params: { page_size: 100, search, status: 'draft,pending_qi,qi_in_progress' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setGrnOptions(
        items.map((grn) => ({
          label: `${grn.grn_number} - ${grn.vendor_name || 'Unknown Vendor'} (${formatDate(grn.grn_date)})`,
          value: grn.id,
          grn,
        }))
      );
      if (items.length === 0) {
        message.info('No GRNs awaiting inspection. Create a GRN first.');
      }
    } catch (e) {
      message.error('Failed to load GRNs. ' + (e?.response?.data?.detail || e?.message || ''));
    }
  }, []);

  // --- Init ---
  useEffect(() => {
    if (!isNew) {
      fetchQI();
    } else {
      loadGRNOptions();
      form.setFieldsValue({
        inspection_date: dayjs(),
        inspection_type: 'full',
      });
    }
  }, [id]);

  // --- Fetch existing QI ---
  const fetchQI = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/quality-inspections/${id}`);
      const data = res.data;
      setQi(data);
      setOverallResult(data.overall_result || null);
      form.setFieldsValue({
        ...data,
        inspection_date: data.inspection_date ? dayjs(data.inspection_date) : null,
      });
      if (data.grn_id) {
        setSelectedGRN({
          grn_number: data.grn_number || '',
          vendor_name: data.vendor_name || '',
          grn_date: data.grn_date || '',
        });
      }
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        grn_item_id: item.grn_item_id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch_number: item.batch_number || '',
        received_qty: item.received_qty || 0,
        inspected_qty: item.inspected_qty || 0,
        accepted_qty: item.accepted_qty || 0,
        rejected_qty: item.rejected_qty || 0,
        hold_qty: item.hold_qty || 0,
        result: item.result || 'accepted',
        rejection_reason: item.rejection_reason || '',
        remarks: item.remarks || '',
      }));
      setQiItems(items);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/warehouse/quality-inspection');
    } finally {
      setLoading(false);
    }
  };

  // --- GRN Selection ---
  const handleGRNSelect = async (grnId) => {
    if (!grnId) {
      setSelectedGRN(null);
      setQiItems([]);
      setOverallResult(null);
      return;
    }
    setLoadingGRN(true);
    try {
      const res = await api.get(`/warehouse/grn/${grnId}`);
      const grnData = res.data;
      setSelectedGRN(grnData);

      const items = (grnData.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        grn_item_id: item.id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch_number: item.batch_number || '',
        received_qty: item.received_qty || 0,
        inspected_qty: item.received_qty || 0,
        accepted_qty: item.accepted_qty || 0,
        rejected_qty: item.rejected_qty || 0,
        hold_qty: (item.received_qty || 0) - (item.accepted_qty || 0) - (item.rejected_qty || 0),
        result: 'accepted',
        rejection_reason: '',
        remarks: '',
      }));
      setQiItems(items);
      calculateOverallResult(items);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingGRN(false);
    }
  };

  // --- Item Updates ---
  const updateQiItem = (key, field, value) => {
    setQiItems((prev) => {
      const updated = prev.map((item) => {
        if (item.key !== key) return item;
        const newItem = { ...item, [field]: value };

        // Auto-calculate accepted = inspected - rejected - hold
        if (field === 'inspected_qty' || field === 'rejected_qty' || field === 'hold_qty') {
          const inspected = field === 'inspected_qty' ? (value || 0) : (newItem.inspected_qty || 0);
          const rejected = field === 'rejected_qty' ? (value || 0) : (newItem.rejected_qty || 0);
          const hold = field === 'hold_qty' ? (value || 0) : (newItem.hold_qty || 0);
          newItem.accepted_qty = Math.max(0, inspected - rejected - hold);
        }

        // Auto-set result based on quantities
        if (field === 'rejected_qty' || field === 'hold_qty' || field === 'inspected_qty') {
          if (newItem.rejected_qty > 0 && newItem.accepted_qty === 0) {
            newItem.result = 'rejected';
          } else if (newItem.hold_qty > 0) {
            newItem.result = 'hold';
          } else {
            newItem.result = 'accepted';
          }
        }

        return newItem;
      });
      calculateOverallResult(updated);
      return updated;
    });
  };

  const calculateOverallResult = (items) => {
    if (!items || items.length === 0) {
      setOverallResult(null);
      return;
    }
    const allAccepted = items.every((i) => i.result === 'accepted');
    const allRejected = items.every((i) => i.result === 'rejected');

    if (allAccepted) {
      setOverallResult('pass');
    } else if (allRejected) {
      setOverallResult('fail');
    } else {
      setOverallResult('partial');
    }
  };

  // --- Submit ---
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      if (qiItems.length === 0) {
        message.error('No items to inspect. Please select a GRN.');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'start') status = 'in_progress';
      if (submitAction === 'complete') status = 'completed';

      const payload = {
        grn_id: values.grn_id,
        inspection_type: values.inspection_type,
        inspection_date: formatDateForAPI(values.inspection_date),
        overall_result: overallResult,
        status,
        remarks: values.remarks || '',
        items: qiItems.map((item) => ({
          grn_item_id: item.grn_item_id,
          item_id: item.item_id,
          inspected_qty: item.inspected_qty,
          accepted_qty: item.accepted_qty,
          rejected_qty: item.rejected_qty,
          hold_qty: item.hold_qty || 0,
          result: item.result,
          rejection_reason: item.rejection_reason || '',
          remarks: item.remarks || '',
        })),
      };

      if (isNew) {
        const res = await api.post('/warehouse/quality-inspections', payload);
        message.success('Quality Inspection created successfully');
        if (submitAction === 'complete') {
          message.info('Putaway will be auto-generated for accepted items.');
        }
        const newId = res.data.id || res.data.data?.id;
        if (newId) {
          navigate(`/warehouse/quality-inspection/${newId}`);
        } else {
          navigate('/warehouse/quality-inspection');
        }
      } else {
        await api.put(`/warehouse/quality-inspections/${id}`, payload);
        message.success('Quality Inspection updated');
        if (submitAction === 'complete') {
          message.info('Putaway will be auto-generated for accepted items.');
        }
        setEditMode(false);
        fetchQI();
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions on existing QI ---
  const handleCompleteQI = async () => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/complete`);
      message.success('Quality Inspection completed. Putaway will be generated.');
      fetchQI();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancelQI = async () => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/cancel`);
      message.success('Quality Inspection cancelled');
      fetchQI();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Overall result display ---
  const getOverallResultDisplay = () => {
    if (!overallResult) return null;
    const config = {
      pass: { color: '#52c41a', label: 'PASS - All items accepted', icon: <CheckOutlined /> },
      fail: { color: '#f5222d', label: 'FAIL - All items rejected', icon: <CloseCircleOutlined /> },
      partial: { color: '#fa8c16', label: 'PARTIAL - Mixed results', icon: <WarningOutlined /> },
    };
    const c = config[overallResult];
    return (
      <Alert
        message={<Text strong style={{ color: c.color }}>{c.label}</Text>}
        type={overallResult === 'pass' ? 'success' : overallResult === 'fail' ? 'error' : 'warning'}
        showIcon
        icon={c.icon}
        style={{ marginBottom: 16 }}
      />
    );
  };

  // --- Loading state ---
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  // ============================
  // VIEW MODE (existing QI)
  // ============================
  if (!isNew && qi && !editMode) {
    const qiItemsList = qi.items || [];
    const statusIdx = QI_STATUS_FLOW.indexOf(qi.status);

    return (
      <div>
        <PageHeader title={qi.qi_number || `QI #${id}`} subtitle="Quality Inspection Detail">
          <Space>
            {(qi.status === 'draft' || qi.status === 'in_progress') && (
              <>
                <Button icon={<EditOutlined />} onClick={() => { setEditMode(true); loadGRNOptions(); }}>
                  Edit
                </Button>
                <Popconfirm
                  title="Complete this QI? Putaway will be auto-generated for accepted items."
                  onConfirm={handleCompleteQI}
                >
                  <Button type="primary" icon={<CheckOutlined />}>Complete &amp; Generate Putaway</Button>
                </Popconfirm>
              </>
            )}
            {qi.status === 'draft' && (
              <Popconfirm title="Cancel this Quality Inspection?" onConfirm={handleCancelQI} okButtonProps={{ danger: true }}>
                <Button danger icon={<CloseCircleOutlined />}>Cancel</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/warehouse/quality-inspection')}>Back</Button>
          </Space>
        </PageHeader>

        {/* Status Flow */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {QI_STATUS_FLOW.map((s, idx) => {
              const isCurrent = s === qi.status;
              const isPast = idx < statusIdx;
              return (
                <Tag
                  key={s}
                  color={qi.status === 'cancelled' ? 'default' : isCurrent ? 'blue' : isPast ? 'green' : 'default'}
                  style={{ padding: '4px 12px', fontSize: 13 }}
                >
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Tag>
              );
            })}
            {qi.status === 'cancelled' && (
              <Tag color="red" style={{ padding: '4px 12px', fontSize: 13 }}>Cancelled</Tag>
            )}
          </div>
        </Card>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="QI Number"><Text strong>{qi.qi_number}</Text></Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={qi.status} /></Descriptions.Item>
            <Descriptions.Item label="Overall Result">
              {qi.overall_result ? (
                <Tag
                  style={{
                    color: '#fff',
                    backgroundColor: resultColors[qi.overall_result] || '#8c8c8c',
                    borderColor: resultColors[qi.overall_result] || '#8c8c8c',
                  }}
                >
                  {qi.overall_result.toUpperCase()}
                </Tag>
              ) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="GRN Reference">{qi.grn_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Inspection Date">{formatDate(qi.inspection_date)}</Descriptions.Item>
            <Descriptions.Item label="Inspection Type">
              <Tag>{qi.inspection_type || '-'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Inspected By">{qi.inspected_by_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Created At">{formatDateTime(qi.created_at)}</Descriptions.Item>
            <Descriptions.Item label="Completed At">{qi.completed_at ? formatDateTime(qi.completed_at) : '-'}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{qi.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card>
          <Divider orientation="left">
            <Space>
              <ExperimentOutlined />
              Inspection Items
              <Badge count={qiItemsList.length} style={{ backgroundColor: '#eb2f96' }} />
            </Space>
          </Divider>
          <Table
            dataSource={qiItemsList}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Name', dataIndex: 'item_name', width: 200, ellipsis: true },
              { title: 'Batch', dataIndex: 'batch_number', width: 90, render: (v) => v || '-' },
              { title: 'Inspected', dataIndex: 'inspected_qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
              {
                title: 'Accepted', dataIndex: 'accepted_qty', width: 100, align: 'right',
                render: (v) => <Text style={{ color: '#52c41a', fontWeight: 600 }}>{formatNumber(v)}</Text>,
              },
              {
                title: 'Rejected', dataIndex: 'rejected_qty', width: 100, align: 'right',
                render: (v) => <Text style={{ color: v > 0 ? '#f5222d' : undefined, fontWeight: v > 0 ? 600 : 400 }}>{formatNumber(v)}</Text>,
              },
              {
                title: 'Hold', dataIndex: 'hold_qty', width: 80, align: 'right',
                render: (v) => <Text style={{ color: v > 0 ? '#fa8c16' : undefined, fontWeight: v > 0 ? 600 : 400 }}>{formatNumber(v)}</Text>,
              },
              {
                title: 'Result', dataIndex: 'result', width: 110,
                render: (v) => {
                  const color = resultColors[v] || '#8c8c8c';
                  const label = v ? v.charAt(0).toUpperCase() + v.slice(1) : '-';
                  return <Tag style={{ color: '#fff', backgroundColor: color, borderColor: color }}>{label}</Tag>;
                },
              },
              { title: 'Rejection Reason', dataIndex: 'rejection_reason', width: 180, render: (v) => v || '-' },
              { title: 'Remarks', dataIndex: 'remarks', width: 150, render: (v) => v || '-' },
            ]}
            summary={() => {
              const totalInspected = qiItemsList.reduce((s, i) => s + (i.inspected_qty || 0), 0);
              const totalAccepted = qiItemsList.reduce((s, i) => s + (i.accepted_qty || 0), 0);
              const totalRejected = qiItemsList.reduce((s, i) => s + (i.rejected_qty || 0), 0);
              const totalHold = qiItemsList.reduce((s, i) => s + (i.hold_qty || 0), 0);
              return (
                <Table.Summary>
                  <Table.Summary.Row>
                    <Table.Summary.Cell colSpan={3} align="right"><Text strong>Totals:</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text strong>{formatNumber(totalInspected)}</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text strong style={{ color: '#52c41a' }}>{formatNumber(totalAccepted)}</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text strong style={{ color: '#f5222d' }}>{formatNumber(totalRejected)}</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text strong style={{ color: '#fa8c16' }}>{formatNumber(totalHold)}</Text></Table.Summary.Cell>
                    <Table.Summary.Cell colSpan={3} />
                  </Table.Summary.Row>
                </Table.Summary>
              );
            }}
          />
        </Card>
      </div>
    );
  }

  // ============================
  // CREATE / EDIT MODE
  // ============================
  const qiItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_name', width: 180, ellipsis: true,
      render: (v, r) => (
        <Tooltip title={`${r.item_code || ''} - ${v}`}>
          <Text ellipsis style={{ maxWidth: 160 }}>{v}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Batch', dataIndex: 'batch_number', width: 90,
      render: (v) => v || '-',
    },
    {
      title: 'Received', dataIndex: 'received_qty', width: 80, align: 'center',
      render: (v) => <Text type="secondary">{formatNumber(v)}</Text>,
    },
    {
      title: 'Inspected', dataIndex: 'inspected_qty', width: 95,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.received_qty}
          value={val}
          onChange={(v) => updateQiItem(record.key, 'inspected_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Accepted', dataIndex: 'accepted_qty', width: 85, align: 'center',
      render: (v) => <Text style={{ color: '#52c41a', fontWeight: 600 }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Rejected', dataIndex: 'rejected_qty', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.inspected_qty}
          value={val}
          onChange={(v) => updateQiItem(record.key, 'rejected_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
          status={val > 0 ? 'error' : undefined}
        />
      ),
    },
    {
      title: 'Hold', dataIndex: 'hold_qty', width: 80,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={(record.inspected_qty || 0) - (record.rejected_qty || 0)}
          value={val}
          onChange={(v) => updateQiItem(record.key, 'hold_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
          status={val > 0 ? 'warning' : undefined}
        />
      ),
    },
    {
      title: 'Result', dataIndex: 'result', width: 120,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateQiItem(record.key, 'result', v)}
          options={QI_RESULT_OPTIONS}
          size="small"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Rejection Reason', dataIndex: 'rejection_reason', width: 160,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateQiItem(record.key, 'rejection_reason', e.target.value)}
          size="small"
          placeholder={record.result === 'rejected' ? 'Reason required...' : 'Optional'}
          disabled={record.result === 'accepted'}
        />
      ),
    },
    {
      title: 'Remarks', dataIndex: 'remarks', width: 140,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateQiItem(record.key, 'remarks', e.target.value)}
          size="small"
          placeholder="Remarks"
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Quality Inspection' : `Edit ${qi?.qi_number || ''}`}
        subtitle={isNew ? 'Create a new quality inspection' : 'Edit quality inspection'}
      >
        <Space>
          <Button onClick={() => navigate('/warehouse/quality-inspection')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} sm={10}>
              <Form.Item name="grn_id" label="Select GRN" rules={[{ required: true, message: 'Please select a GRN' }]}>
                <Select
                  options={grnOptions}
                  placeholder="Search and select GRN..."
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleGRNSelect}
                  onSearch={(v) => loadGRNOptions(v)}
                  loading={loadingGRN}
                  disabled={!isNew && !!qi?.grn_id}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={6}>
              <Form.Item name="inspection_date" label="Inspection Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="inspection_type" label="Inspection Type" rules={[{ required: true, message: 'Required' }]}>
                <Select options={INSPECTION_TYPES} placeholder="Select type" />
              </Form.Item>
            </Col>
          </Row>

          {/* GRN Summary */}
          {selectedGRN && (
            <Card size="small" style={{ background: '#f9f9f9', marginBottom: 16 }}>
              <Descriptions size="small" column={{ xs: 1, sm: 4 }}>
                <Descriptions.Item label="GRN Number">{selectedGRN.grn_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Vendor">{selectedGRN.vendor_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="GRN Date">{formatDate(selectedGRN.grn_date)}</Descriptions.Item>
                <Descriptions.Item label="Total Qty">{formatNumber(selectedGRN.total_qty)}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="General inspection remarks..." />
          </Form.Item>
        </Form>

        {/* Overall Result */}
        {getOverallResultDisplay()}

        {/* Items Table */}
        {qiItems.length > 0 && (
          <>
            <Divider orientation="left">
              <Space>
                <ExperimentOutlined />
                Inspection Items
                <Badge count={qiItems.length} style={{ backgroundColor: '#eb2f96' }} />
              </Space>
            </Divider>
            <Table
              dataSource={qiItems}
              columns={qiItemColumns}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: 1400 }}
              loading={loadingGRN}
            />

            {/* Summary Stats */}
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ width: 380 }}>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total Inspected:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text strong>{formatNumber(qiItems.reduce((s, i) => s + (i.inspected_qty || 0), 0))}</Text>
                  </Col>
                </Row>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total Accepted:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text style={{ color: '#52c41a', fontWeight: 600 }}>
                      {formatNumber(qiItems.reduce((s, i) => s + (i.accepted_qty || 0), 0))}
                    </Text>
                  </Col>
                </Row>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total Rejected:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text style={{ color: '#f5222d', fontWeight: 600 }}>
                      {formatNumber(qiItems.reduce((s, i) => s + (i.rejected_qty || 0), 0))}
                    </Text>
                  </Col>
                </Row>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total On Hold:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text style={{ color: '#fa8c16', fontWeight: 600 }}>
                      {formatNumber(qiItems.reduce((s, i) => s + (i.hold_qty || 0), 0))}
                    </Text>
                  </Col>
                </Row>
                <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
                  <Col span={14}><Text strong style={{ fontSize: 15 }}>Overall Result:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    {overallResult ? (
                      <Tag
                        style={{
                          color: '#fff',
                          backgroundColor: resultColors[overallResult] || '#8c8c8c',
                          borderColor: resultColors[overallResult] || '#8c8c8c',
                          fontSize: 14,
                          padding: '2px 12px',
                        }}
                      >
                        {overallResult.toUpperCase()}
                      </Tag>
                    ) : (
                      <Text type="secondary">-</Text>
                    )}
                  </Col>
                </Row>
              </div>
            </div>
          </>
        )}

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/warehouse/quality-inspection')}>Cancel</Button>
          <Button icon={<SaveOutlined />} onClick={() => handleSubmit('draft')} loading={submitting}>
            Save as Draft
          </Button>
          <Button onClick={() => handleSubmit('start')} loading={submitting}>
            Start Inspection
          </Button>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={() => handleSubmit('complete')}
            loading={submitting}
          >
            Complete &amp; Generate Putaway
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default QualityInspectionForm;
