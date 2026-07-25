// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Table, Divider, Typography, Tooltip, Tag, Badge, Alert, Row, Col, Spin, message,
} from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, CheckOutlined, ExperimentOutlined,
  CloseCircleOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageHeader from '../components/PageHeader';
import api from '../config/api';
import {
  formatDate, formatNumber, getErrorMessage, formatDateForAPI, formatDateTime,
} from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const OUTWARD_DISCRIMINATOR = 'outgoing';

const QI_RESULT_OPTIONS = [
  { label: 'Accepted', value: 'accepted' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Hold', value: 'hold' },
];

const resultColors = {
  accepted: '#52c41a',
  pass: '#52c41a',
  rejected: '#f5222d',
  fail: '#f5222d',
  hold: '#fa8c16',
  partial: '#fa8c16',
};

const QCOutwardForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form states
  const [qiItems, setQiItems] = useState([]);
  const [sourceOptions, setSourceOptions] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [overallResult, setOverallResult] = useState(null);
  const [existingRecord, setExistingRecord] = useState(null);

  const loadSourceOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/warehouse/material-issues', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setSourceOptions(
        items.map((mi) => ({
          label: `${mi.mi_number || mi.issue_number || `MI-${mi.id}`} - ${mi.indent_number || mi.reference_number || ''} (${formatDate(mi.issue_date || mi.created_at)})`,
          value: mi.id,
          source: mi,
        }))
      );
    } catch { /* silent */ }
  }, []);

  const fetchQC = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/quality-inspections/${id}`);
      const data = res.data;
      setExistingRecord(data);
      form.setFieldsValue({
        source_id: data.grn_id || data.material_issue_id,
        inspection_date: data.inspection_date ? dayjs(data.inspection_date) : null,
        remarks: data.remarks,
      });
      setOverallResult(data.overall_result);
      setQiItems((data.items || []).map((it, idx) => ({
        ...it,
        key: it.id || idx,
        item_name: it.item_name || (it.item && it.item.name) || '',
        item_code: it.item_code || (it.item && it.item.item_code) || '',
        physical_qty: it.physical_qty || it.inspected_qty || 0,
      })));
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/warehouse/qc-outward');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSourceOptions();
    if (!isNew) {
      fetchQC();
    } else {
      form.setFieldsValue({
        inspection_date: dayjs(),
      });
    }
  }, [id, isNew]);

  const handleSourceSelect = async (sourceId) => {
    if (!sourceId) {
      setSelectedSource(null);
      setQiItems([]);
      return;
    }
    setLoadingSource(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${sourceId}`);
      const sourceData = res.data;
      setSelectedSource(sourceData);

      const items = (sourceData.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        grn_item_id: item.id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch_number: item.batch_number || '',
        physical_qty: item.issued_qty || item.quantity || 0,
        inspected_qty: item.issued_qty || item.quantity || 0,
        accepted_qty: item.issued_qty || item.quantity || 0,
        rejected_qty: 0,
        hold_qty: 0,
        result: 'accepted',
        rejection_reason: '',
        remarks: '',
      }));
      setQiItems(items);
      calculateOverallResult(items);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingSource(false);
    }
  };

  const updateQiItem = (key, field, value) => {
    setQiItems((prev) => {
      const updated = prev.map((item) => {
        if (item.key !== key) return item;
        const newItem = { ...item, [field]: value };

        if (field === 'inspected_qty' || field === 'rejected_qty' || field === 'hold_qty') {
          const inspected = field === 'inspected_qty' ? (value || 0) : (newItem.inspected_qty || 0);
          const rejected = field === 'rejected_qty' ? (value || 0) : (newItem.rejected_qty || 0);
          const hold = field === 'hold_qty' ? (value || 0) : (newItem.hold_qty || 0);
          newItem.accepted_qty = Math.max(0, inspected - rejected - hold);
        }

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

  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      if (qiItems.length === 0) {
        message.error('No items to inspect. Please select a source document.');
        return;
      }

      let status = 'draft';
      if (submitAction === 'start') status = 'in_progress';
      if (submitAction === 'complete') status = 'completed';

      const payload = {
        grn_id: values.source_id,
        inspection_date: formatDateForAPI(values.inspection_date),
        inspection_type: OUTWARD_DISCRIMINATOR,
        overall_result: overallResult,
        status,
        remarks: values.remarks,
        items: qiItems.map((item) => ({
          grn_item_id: item.grn_item_id,
          item_id: item.item_id,
          inspected_qty: item.inspected_qty,
          accepted_qty: item.accepted_qty,
          rejected_qty: item.rejected_qty,
          hold_qty: item.hold_qty,
          result: item.result,
          rejection_reason: item.rejection_reason,
          remarks: item.remarks,
        })),
      };

      setSubmitting(true);
      await api.post('/warehouse/quality-inspections', payload);
      message.success('Outward QC created successfully');
      navigate('/warehouse/qc-outward');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

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
      title: 'Physical Qty', dataIndex: 'physical_qty', width: 100, align: 'center',
      render: (v) => <Text type="secondary">{formatNumber(v)}</Text>,
    },
    {
      title: 'Inspected', dataIndex: 'inspected_qty', width: 90,
      render: (val, record) => !isNew ? formatNumber(val) : (
        <InputNumber
          min={0}
          max={record.physical_qty}
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
      title: 'Rejected', dataIndex: 'rejected_qty', width: 85,
      render: (val, record) => !isNew ? formatNumber(val) : (
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
      render: (val, record) => !isNew ? formatNumber(val) : (
        <InputNumber
          min={0}
          max={record.inspected_qty - (record.rejected_qty || 0)}
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
      render: (val, record) => !isNew ? (
        <Tag style={{ color: '#fff', backgroundColor: resultColors[val] || '#8c8c8c', borderColor: resultColors[val] || '#8c8c8c' }}>
          {val ? val.toUpperCase() : '-'}
        </Tag>
      ) : (
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
      render: (val, record) => !isNew ? (val || '-') : (
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
      render: (val, record) => !isNew ? (val || '-') : (
        <Input
          value={val}
          onChange={(e) => updateQiItem(record.key, 'remarks', e.target.value)}
          size="small"
          placeholder="Remarks"
        />
      ),
    },
  ];

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

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <PageHeader title={isNew ? 'New Outward QC' : `Outward QC: ${existingRecord?.qi_number || ''}`} subtitle="Pre-dispatch quality check vs physical stock">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/warehouse/qc-outward')}>Back to QC List</Button>
          {isNew && (
            <>
              <Button onClick={() => handleSubmit('draft')} loading={submitting}>
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
                Complete Outward QC
              </Button>
            </>
          )}
        </Space>
      </PageHeader>
      <Card>
        <Form form={form} layout="vertical" requiredMark="optional" disabled={!isNew}>
          <Row gutter={16}>
            <Col span={14}>
              <Form.Item name="source_id" label="Source Document (Material Issue / Picking Order)" rules={[{ required: true, message: 'Please select a source document' }]}>
                {!isNew ? (
                  <Input placeholder="Source reference" disabled />
                ) : (
                  <Select
                    options={sourceOptions}
                    placeholder="Search and select source..."
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    onChange={handleSourceSelect}
                    onSearch={(v) => loadSourceOptions(v)}
                    loading={loadingSource}
                  />
                )}
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="inspection_date" label="Inspection Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          {selectedSource && (
            <Card size="small" style={{ background: '#f9f9f9', marginBottom: 16 }}>
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="MI Number">{selectedSource.mi_number || selectedSource.issue_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Indent Ref">{selectedSource.indent_number || selectedSource.reference_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Issue Date">{formatDate(selectedSource.issue_date || selectedSource.created_at)}</Descriptions.Item>
                <Descriptions.Item label="Total Qty">{formatNumber(selectedSource.total_qty || (selectedSource.items || []).reduce((s, i) => s + (i.issued_qty || i.quantity || 0), 0))}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          {existingRecord && (
            <Card size="small" style={{ background: '#f9f9f9', marginBottom: 16 }}>
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="Status"><Tag color={existingRecord.status === 'completed' ? 'green' : 'blue'}>{(existingRecord.status || '').toUpperCase()}</Tag></Descriptions.Item>
                <Descriptions.Item label="Source Reference">{existingRecord.source_reference || existingRecord.mi_number || existingRecord.grn_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Inspected By">{existingRecord.inspected_by_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Created At">{formatDateTime(existingRecord.created_at)}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="General outward QC remarks..." />
          </Form.Item>
        </Form>

        {getOverallResultDisplay()}

        {qiItems.length > 0 && (
          <>
            <Divider orientation="left">
              <Space>
                <ExperimentOutlined />
                Outward QC Items
                <Badge count={qiItems.length} style={{ backgroundColor: '#fa8c16' }} />
              </Space>
            </Divider>
            <Table
              dataSource={qiItems}
              columns={qiItemColumns}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: 1400 }}
              loading={loadingSource}
            />

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
      </Card>
    </div>
  );
};

export default QCOutwardForm;
