// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Divider, Typography, Tag, Spin, Popconfirm, Tooltip, Radio, Image,
  Steps, Modal
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SaveOutlined, MinusCircleOutlined,
  CheckOutlined, EditOutlined, DeleteOutlined, BarcodeOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import ItemSelector from '../components/ItemSelector';
import SerialNumbersModal from '../components/SerialNumbersModal';
import api from '../config/api';
import { formatDate, getErrorMessage, formatDateForAPI, formatNumber } from '../utils/helpers';
import { DATE_FORMAT } from '../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const DispatchForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryIssueId = searchParams.get('issue_id');
  const isNew = !id || id === 'new';
  const [form] = Form.useForm();

  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [editMode, setEditMode] = useState(isNew);
  const [dispatchData, setDispatchData] = useState(null);

  // Lookups
  const [indents, setIndents] = useState([]);
  const [materialIssues, setMaterialIssues] = useState([]);
  const [uoms, setUoms] = useState([]);

  // Reference items
  const [selectedIndentItems, setSelectedIndentItems] = useState([]);
  const [selectedIssueItems, setSelectedIssueItems] = useState([]);
  const [selectedIndent, setSelectedIndent] = useState(null);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [loadingIndent, setLoadingIndent] = useState(false);
  const [loadingIssue, setLoadingIssue] = useState(false);

  const [warehouses, setWarehouses] = useState([]);
  const [usersLookup, setUsersLookup] = useState([]);

  const destinationType = Form.useWatch('destination_type', form) || 'USER';
  const dispatchType = Form.useWatch('dispatch_type', form) || 'THIRD_PARTY';
  const dispatchMode = Form.useWatch('dispatch_mode', form) || 'direct';
  const destinationWarehouseId = Form.useWatch('destination_warehouse_id', form);
  const destinationUserId = Form.useWatch('destination_user_id', form);

  const [custodyChain, setCustodyChain] = useState([]);
  const [loadingChain, setLoadingChain] = useState(false);
  const [custodyModalOpen, setCustodyModalOpen] = useState(false);
  const [custodySubmitting, setCustodySubmitting] = useState(false);
  const [custodyForm] = Form.useForm();

  const fetchSavedCustodyChain = useCallback(async () => {
    if (isNew) return;
    setLoadingChain(true);
    try {
      const res = await api.get(`/warehouse/dispatch/${id}/custody-chain`);
      setCustodyChain(res.data || []);
    } catch (err) {
      console.error('Failed to fetch custody chain', err);
    } finally {
      setLoadingChain(false);
    }
  }, [id, isNew]);

  useEffect(() => {
    if (!isNew) return;
    
    const fetchPreview = async () => {
      const projectId = selectedIndent?.project_id;
      if (!projectId || dispatchMode !== 'multi-level') {
        setCustodyChain([]);
        return;
      }
      
      const params = { project_id: projectId };
      if (destinationType === 'WAREHOUSE' && destinationWarehouseId) {
        params.destination_warehouse_id = destinationWarehouseId;
      } else if (destinationType === 'USER' && destinationUserId) {
        params.destination_user_id = destinationUserId;
      } else {
        setCustodyChain([]);
        return;
      }

      setLoadingChain(true);
      try {
        const res = await api.get('/warehouse/dispatch/custody-chain-preview', { params });
        setCustodyChain(res.data || []);
      } catch (err) {
        console.error('Failed to preview custody chain', err);
        setCustodyChain([]);
      } finally {
        setLoadingChain(false);
      }
    };

    fetchPreview();
  }, [isNew, selectedIndent, destinationType, destinationWarehouseId, destinationUserId, dispatchMode]);

  const loadLookups = useCallback(async () => {
    try {
      // For dispatch: fetch approved indents (not restricted to available_for_issue)
      // because a dispatched MI may reference a fully-issued indent that is no longer
      // 'available for issue' but must still appear in the dropdown.
      const [indentRes, issueRes, uomRes, warehouseRes, userRes] = await Promise.allSettled([
        api.get('/indents', { params: { page_size: 100, status: 'approved' } }),
        api.get('/warehouse/material-issues', { params: { page_size: 100, status: 'issued' } }),
        api.get('/masters/uom', { params: { page_size: 100 } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/users/lookup', { params: { page_size: 200 } }),
      ]);

      if (indentRes.status === 'fulfilled') {
        const data = indentRes.value.data;
        const items = data.items || data.data || data || [];
        setIndents(items.map(i => ({ label: i.indent_number, value: i.id })));
      }
      if (issueRes.status === 'fulfilled') {
        const data = issueRes.value.data;
        // Backend already filters by status='issued'; map to options.
        // Include indent_number in the label so users can see which indent the MI was raised against.
        const items = data.items || data.data || data || [];
        setMaterialIssues(items.map(i => ({
          label: i.indent_number
            ? `${i.issue_number} · Indent: ${i.indent_number}`
            : i.issue_number,
          value: i.id,
        })));
      }
      if (uomRes.status === 'fulfilled') {
        const data = uomRes.value.data;
        const items = data.items || data.data || data || [];
        setUoms(items.map(i => ({ label: i.name, value: i.name })));
      }
      if (warehouseRes.status === 'fulfilled') {
        const data = warehouseRes.value.data;
        const items = data.items || data.data || data || [];
        setWarehouses(items.map(w => ({ label: w.name, value: w.id })));
      }
      if (userRes.status === 'fulfilled') {
        const data = userRes.value.data;
        const items = data.items || data.data || data || [];
        setUsersLookup(items.map(u => ({ label: `${u.first_name} ${u.last_name || ''}`.trim(), value: u.id })));
      }
    } catch (err) {
      console.error('Failed to load lookups', err);
    }
  }, []);

  const handleIndentSelect = async (indentId) => {
    if (!indentId) { setSelectedIndentItems([]); setSelectedIndent(null); return; }
    setLoadingIndent(true);
    try {
      const res = await api.get(`/indents/${indentId}`);
      setSelectedIndent(res.data);
      setSelectedIndentItems((res.data.items || []).map(item => ({
        ...item,
        dispatched_quantity: 0,
        serial_numbers: [],
        key: item.id || Math.random()
      })));
    } catch (err) {
      message.error('Failed to load indent items');
    } finally {
      setLoadingIndent(false);
    }
  };

  const handleIssueSelect = async (issueId) => {
    if (!issueId) {
      setSelectedIssueItems([]);
      setSelectedIssue(null);
      form.setFieldValue('indent_id_ref', undefined);
      setSelectedIndentItems([]);
      setSelectedIndent(null);
      return;
    }
    setLoadingIssue(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${issueId}`);
      const issueData = res.data;
      setSelectedIssue(issueData);
      // Inject the MI option with indent label into the dropdown so label renders correctly
      const miLabel = issueData.indent_number
        ? `${issueData.issue_number} · Indent: ${issueData.indent_number}`
        : issueData.issue_number;
      setMaterialIssues(prev =>
        prev.some(i => i.value === issueData.id)
          ? prev.map(i => i.value === issueData.id ? { ...i, label: miLabel } : i)
          : [...prev, { label: miLabel, value: issueData.id }]
      );
      setSelectedIssueItems((issueData.items || []).map(item => ({
        ...item,
        dispatched_quantity: item.qty || 0,
        serial_numbers: item.serial_numbers || [],
        key: item.id || Math.random()
      })));

      if (issueData.indent_id) {
        // Fetch the linked indent details so we can show its info card and items
        setLoadingIndent(true);
        try {
          const indentRes = await api.get(`/indents/${issueData.indent_id}`);
          const indentData = indentRes.data;
          setSelectedIndent(indentData);
          setSelectedIndentItems((indentData.items || []).map(item => ({
            ...item,
            dispatched_quantity: 0,
            serial_numbers: [],
            key: item.id || Math.random()
          })));
          // Ensure the indent option is present in the dropdown so the label renders
          const indentOption = { label: indentData.indent_number, value: indentData.id };
          setIndents(prev =>
            prev.some(i => i.value === indentData.id) ? prev : [...prev, indentOption]
          );
          // Set the form value AFTER the option is injected so Ant Design can resolve the label
          form.setFieldValue('indent_id_ref', indentData.id);
        } catch (indentErr) {
          console.error('Failed to load linked indent details', indentErr);
          form.setFieldValue('indent_id_ref', issueData.indent_id);
        } finally {
          setLoadingIndent(false);
        }
      } else {
        form.setFieldValue('indent_id_ref', undefined);
        setSelectedIndentItems([]);
        setSelectedIndent(null);
      }
    } catch (err) {
      console.error('Failed to load material issue details', err);
      message.error('Failed to load material issue items');
    } finally {
      setLoadingIssue(false);
    }
  };


  const fetchDispatch = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/dispatch/${id}`);
      const data = res.data;
      setDispatchData(data);
      form.setFieldsValue({
        ...data,
        dispatch_mode: data.dispatch_mode || 'direct',
        dispatch_date: data.dispatch_date ? dayjs(data.dispatch_date) : null,
        expected_delivery_date: data.expected_delivery_date ? dayjs(data.expected_delivery_date) : null,
      });
      if (data.dispatch_mode === 'multi-level') {
        fetchSavedCustodyChain();
      }
      if (data.items && data.items.length > 0) {
        const firstItem = data.items[0];
        if (firstItem.indent_id) {
          const indentRes = await api.get(`/indents/${firstItem.indent_id}`);
          const indentData = indentRes.data;
          setSelectedIndent(indentData);
          setSelectedIndentItems((indentData.items || []).map(item => {
            const matched = data.items.find(di => di.material_id === item.item_id);
            return {
              ...item,
              dispatched_quantity: matched ? matched.dispatched_quantity : 0,
              serial_numbers: matched ? (matched.serial_numbers || []) : [],
              key: item.id || Math.random()
            };
          }));
          // Ensure the indent option exists in the dropdown so the label renders correctly
          setIndents(prev =>
            prev.some(i => i.value === indentData.id)
              ? prev
              : [...prev, { label: indentData.indent_number, value: indentData.id }]
          );
          form.setFieldValue('indent_id_ref', indentData.id);
        }
        if (firstItem.material_issue_id) {
          const issueRes = await api.get(`/warehouse/material-issues/${firstItem.material_issue_id}`);
          const issueData = issueRes.data;
          setSelectedIssue(issueData);
          setSelectedIssueItems((issueData.items || []).map(item => {
            const matched = data.items.find(di => di.material_id === item.item_id);
            return {
              ...item,
              dispatched_quantity: matched ? matched.dispatched_quantity : (item.qty || 0),
              serial_numbers: matched ? (matched.serial_numbers || []) : (item.serial_numbers || []),
              key: item.id || Math.random()
            };
          }));
          // Ensure the material issue option exists in the dropdown so the label renders
          setMaterialIssues(prev =>
            prev.some(i => i.value === issueData.id)
              ? prev
              : [...prev, { label: issueData.issue_number, value: issueData.id }]
          );
          form.setFieldValue('issue_id_ref', issueData.id);
        }
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/logistics/dispatch-orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchDispatch();
    } else {
      form.setFieldsValue({
        dispatch_date: dayjs(),
        status: 'Draft',
        destination_type: 'USER',
        dispatch_type: 'THIRD_PARTY',
        dispatch_mode: 'direct',
        issue_id_ref: queryIssueId ? Number(queryIssueId) : undefined,
      });
      if (queryIssueId) handleIssueSelect(Number(queryIssueId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, queryIssueId]);

  useEffect(() => {
    if (selectedIndent && !indents.some(i => i.value === selectedIndent.id)) {
      setIndents(prev => [...prev, { label: selectedIndent.indent_number, value: selectedIndent.id }]);
    }
  }, [selectedIndent, indents]);

  useEffect(() => {
    if (selectedIssue && !materialIssues.some(i => i.value === selectedIssue.id)) {
      setMaterialIssues(prev => [...prev, { label: selectedIssue.issue_number, value: selectedIssue.id }]);
    }
  }, [selectedIssue, materialIssues]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();

      const indentDispatchItems = selectedIndentItems
        .filter(item => item.dispatched_quantity > 0)
        .map(item => ({
          material_id: item.item_id,
          indent_id: values.indent_id_ref,
          material_issue_id: null,
          requested_quantity: item.requested_qty || 0,
          approved_quantity: item.approved_qty || 0,
          dispatched_quantity: item.dispatched_quantity,
          uom: item.uom_name || item.uom || '',
          request_date: item.required_date
            ? formatDateForAPI(item.required_date)
            : formatDateForAPI(values.dispatch_date || dayjs()),
          serial_numbers: item.serial_numbers && item.serial_numbers.length > 0
            ? item.serial_numbers : null,
        }));

      const issueDispatchItems = selectedIssueItems
        .filter(item => item.dispatched_quantity > 0)
        .map(item => ({
          material_id: item.item_id,
          indent_id: item.indent_id || values.indent_id_ref,
          material_issue_id: values.issue_id_ref,
          requested_quantity: item.requested_qty || 0,
          approved_quantity: item.qty || 0,
          dispatched_quantity: item.dispatched_quantity,
          uom: item.uom_name || item.uom || '',
          request_date: formatDateForAPI(values.dispatch_date || dayjs()),
          serial_numbers: item.serial_numbers && item.serial_numbers.length > 0
            ? item.serial_numbers : null,
        }));

      const finalItems = [...indentDispatchItems, ...issueDispatchItems];
      if (finalItems.length === 0) {
        message.error('Please enter dispatched quantity for at least one item');
        return;
      }

      setSubmitting(true);
      const payload = {
        ...values,
        dispatch_date: formatDateForAPI(values.dispatch_date),
        expected_delivery_date: values.expected_delivery_date
          ? formatDateForAPI(values.expected_delivery_date) : undefined,
        items: finalItems,
      };

      if (isNew) {
        await api.post('/warehouse/dispatch', payload);
        message.success('Dispatch created successfully');
      } else {
        await api.put(`/warehouse/dispatch/${id}`, payload);
        message.success('Dispatch updated successfully');
      }
      navigate('/logistics/dispatch-orders');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '50px' }}><Spin size="large" /></div>;
  }

  return (
    <div className="page-container">
      <PageHeader title={isNew ? 'New Dispatch' : `Dispatch ${id}`}>
        <Space>
          <Button key="back" onClick={() => navigate('/logistics/dispatch-orders')} icon={<ArrowLeftOutlined />}>
            Back
          </Button>
          {editMode && (
            <Button key="save" type="primary" icon={<SaveOutlined />} loading={submitting} onClick={handleSubmit}>
              Save Dispatch
            </Button>
          )}
          {!editMode && form.getFieldValue('status') === 'Draft' && (
            <Button key="edit" type="primary" icon={<EditOutlined />} onClick={() => setEditMode(true)}>
              Edit
            </Button>
          )}
        </Space>
      </PageHeader>

      <Row gutter={[16, 16]}>
        {/* Dispatch Mode Card at top */}
        <Col span={24}>
          <Card
            size="small"
            style={{
              marginBottom: 0,
              borderRadius: '12px',
              border: dispatchMode === 'multi-level' ? '1.5px solid #f59e0b' : '1px solid #cbd5e1',
              background: dispatchMode === 'multi-level' ? '#fffbeb' : '#ffffff',
            }}
          >
            <Row align="middle" gutter={16}>
              <Col flex="auto">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Tag
                    color={dispatchMode === 'multi-level' ? 'gold' : 'blue'}
                    style={{ border: 'none', fontWeight: 700, borderRadius: '4px', margin: 0 }}
                  >
                    {dispatchMode === 'multi-level' ? 'MULTI-LEVEL' : 'DIRECT'}
                  </Tag>
                  <span style={{ fontSize: '13px', color: '#334155', fontWeight: 500 }}>
                    {dispatchMode === 'multi-level'
                      ? 'Shipment will route through intermediate custody positions per project workflow configuration.'
                      : 'Shipment will be dispatched directly to the destination without intermediate custody stops.'}
                  </span>
                </div>
              </Col>
              <Col>
                <Form.Item name="dispatch_mode" style={{ margin: 0 }} rules={[{ required: true, message: 'Please select dispatch mode' }]}>
                  <Radio.Group buttonStyle="solid" disabled={!editMode}>
                    <Radio.Button value="direct">Direct Dispatch</Radio.Button>
                    <Radio.Button value="multi-level">Multi-Level Dispatch</Radio.Button>
                  </Radio.Group>
                </Form.Item>
              </Col>
            </Row>
          </Card>
        </Col>

        {dispatchData && dispatchData.delivery_acknowledged && (
          <Col span={24}>
            <Card 
              title={<span style={{ color: '#0f172a', fontWeight: 800 }}>Proof of Delivery (POD) / Receipt Acknowledgement Details</span>}
              size="small"
              style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', background: '#f8fafc' }}
            >
              <Row gutter={[24, 16]}>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Receiver Name</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>{dispatchData.delivery_acknowledged_by_name || '—'}</strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Designation / Department</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>
                    {dispatchData.delivery_acknowledged_by_designation || '—'} 
                    {dispatchData.delivery_acknowledged_by_department ? ` (${dispatchData.delivery_acknowledged_by_department})` : ''}
                  </strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Contact / Phone</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>{dispatchData.delivery_acknowledged_by_phone || '—'}</strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Acknowledgement Date</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>{formatDate(dispatchData.delivery_acknowledged_at)}</strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Goods Condition</Text>
                  <div>
                    <Tag color={dispatchData.goods_condition_on_delivery === 'GOOD' ? 'green' : 'orange'} style={{ fontWeight: 'bold' }}>
                      {dispatchData.goods_condition_on_delivery || 'GOOD'}
                    </Tag>
                  </div>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Remarks / Discrepancy</Text>
                  <strong style={{ color: '#0f172a', fontSize: '13px' }}>{dispatchData.delivery_remarks || '—'}</strong>
                </Col>
                
                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>📝 Receiver Signature / Stamp</Text>
                  {dispatchData.receiver_signature_url ? (
                    <div style={{ background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', padding: '16px', borderRadius: '12px', border: '2px solid #86efac' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#166534', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>✓ Uploaded — Click image to zoom full screen</span>
                      <Image.PreviewGroup>
                        <Image
                          src={dispatchData.receiver_signature_url}
                          alt="Receiver Signature"
                          style={{ width: '100%', maxHeight: '280px', objectFit: 'contain', borderRadius: '8px', border: '2px solid #86efac', background: '#fff', display: 'block' }}
                          preview={{ mask: <span style={{ fontSize: '13px', fontWeight: 600 }}>🔍 Click to Zoom</span> }}
                        />
                      </Image.PreviewGroup>
                    </div>
                  ) : (
                    <div style={{ background: '#fafafa', padding: '20px', borderRadius: '10px', border: '1.5px dashed #cbd5e1', textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: '13px' }}>No signature image uploaded yet</Text>
                    </div>
                  )}
                </Col>

                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>📦 Delivery Photos (Evidence)</Text>
                  {dispatchData.delivery_photo_urls && dispatchData.delivery_photo_urls.photo ? (
                    <div style={{ background: 'linear-gradient(135deg,#f0f9ff,#e0f2fe)', padding: '16px', borderRadius: '12px', border: '2px solid #7dd3fc' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#075985', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>✓ Evidence Photo — Click to zoom</span>
                      <Image.PreviewGroup>
                        <Image
                          src={dispatchData.delivery_photo_urls.photo}
                          alt="Delivery Evidence"
                          style={{ width: '100%', maxHeight: '280px', objectFit: 'contain', borderRadius: '8px', border: '2px solid #7dd3fc', background: '#fff', display: 'block' }}
                          preview={{ mask: <span style={{ fontSize: '13px', fontWeight: 600 }}>🔍 Click to Zoom</span> }}
                        />
                      </Image.PreviewGroup>
                      {dispatchData.delivery_photo_urls.review && (
                        <div style={{ marginTop: '10px', padding: '10px 14px', background: 'rgba(7,89,133,0.07)', borderRadius: '8px', borderLeft: '3px solid #0891b2' }}>
                          <Text style={{ fontSize: '12px', color: '#075985', fontStyle: 'italic', display: 'block' }}>
                            💬 Condition Assessment: {dispatchData.delivery_photo_urls.review}
                          </Text>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ background: '#fafafa', padding: '20px', borderRadius: '10px', border: '1.5px dashed #cbd5e1', textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: '13px' }}>No delivery photos uploaded</Text>
                    </div>
                  )}
                </Col>
              </Row>
            </Card>
          </Col>
        )}
        {/* Left Side: Indent Reference */}
        <Col xs={24} lg={12}>
          <Card title="Indent Reference" size="small">
            <Form form={form} layout="vertical">
              <Form.Item name="indent_id_ref" label="Indent">
                <Select
                  showSearch
                  placeholder="Select an Indent"
                  options={indents}
                  onChange={handleIndentSelect}
                  allowClear
                  disabled={!editMode}
                />
              </Form.Item>
            </Form>
            {selectedIndent && (
              <div style={{
                background: '#fafafa', padding: '10px 14px',
                borderRadius: '6px', marginBottom: '14px', border: '1px solid #f0f0f0'
              }}>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Req. Warehouse</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIndent.warehouse_name || '—'}</Text>
                  </Col>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Req. User</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIndent.raised_by_name || '—'}</Text>
                  </Col>
                </Row>
              </div>
            )}
            <Table
              dataSource={selectedIndentItems}
              size="small"
              pagination={false}
              loading={loadingIndent}
              scroll={{ y: 300 }}
              columns={[
                { title: 'Material', render: (_, r) => r.item_name || r.item?.name },
                { title: 'Req. Qty', dataIndex: 'requested_qty', width: 90 },
                { title: 'Req. Date', dataIndex: 'required_date', render: d => formatDate(d), width: 100 },
              ]}
            />
          </Card>
        </Col>

        {/* Right Side: Material Issue Reference */}
        <Col xs={24} lg={12}>
          <Card title="Material Issue Reference" size="small">
            <Form form={form} layout="vertical">
              <Form.Item name="issue_id_ref" label="Material Issue">
                <Select
                  showSearch
                  placeholder="Select a Material Issue"
                  options={materialIssues}
                  onChange={handleIssueSelect}
                  allowClear
                  disabled={!editMode}
                />
              </Form.Item>
            </Form>
            {selectedIssue && (
              <div style={{
                background: '#fafafa', padding: '10px 14px',
                borderRadius: '6px', marginBottom: '14px', border: '1px solid #f0f0f0'
              }}>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Dispatch Warehouse</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIssue.destination_warehouse_name || '—'}</Text>
                  </Col>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Issued To</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIssue.issued_to_name || selectedIssue.issued_to || '—'}</Text>
                  </Col>
                </Row>
                <Row gutter={16} style={{ marginTop: 8 }}>
                  <Col span={24}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Indent Reference</Text>
                    {selectedIssue.indent_number ? (
                      <Text strong style={{ fontSize: '13px', color: '#1677ff' }}>
                        {selectedIssue.indent_number}
                      </Text>
                    ) : (
                      <Text type="secondary" style={{ fontSize: '13px' }}>No indent linked to this issue</Text>
                    )}
                  </Col>
                </Row>
              </div>
            )}
            <Table
              dataSource={selectedIssueItems}
              size="small"
              pagination={false}
              loading={loadingIssue}
              scroll={{ y: 300, x: 520 }}
              columns={[
                { title: 'Material', render: (_, r) => r.item_name || r.item?.name, ellipsis: true },
                { title: 'Appr. Qty', dataIndex: 'qty', width: 80, render: val => formatNumber(val) },
                { title: 'Disp. Qty', dataIndex: 'dispatched_quantity', width: 80, render: val => formatNumber(val) },
                { title: 'Batch', dataIndex: 'batch_number', width: 90 },
                {
                  title: 'Serial Nos',
                  dataIndex: 'serial_numbers',
                  width: 150,
                  render: (serials, record) => (
                    <SerialNumbersModal
                      value={serials || []}
                      itemName={record.item_name || record.item?.name}
                      itemCode={record.item_code}
                      quantity={Math.round(Number(record.dispatched_quantity || record.qty || 0))}
                      hasSerial={record.has_serial || (serials && serials.length > 0)}
                      size="small"
                      readOnly
                    />
                  ),
                },
              ]}
            />
            {selectedIssueItems.some(i => i.serial_numbers && i.serial_numbers.length > 0) && (
              <div style={{
                marginTop: 8, padding: '6px 10px',
                background: '#e6f7ff', border: '1px solid #91d5ff',
                borderRadius: 4, fontSize: 12, color: '#0050b3',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <BarcodeOutlined />
                Serial numbers from the Material Issue will be automatically carried over to this dispatch.
              </div>
            )}
          </Card>
        </Col>

        {/* Footer: Dispatch Details */}
        <Col span={24}>
          <Card size="small">
            <Form form={form} layout="horizontal">
              <Row gutter={24}>
                <Col span={12} style={{ marginBottom: '16px' }}>
                  <Form.Item name="dispatch_type" label="Shipment Type / Method" rules={[{ required: true }]}>
                    <Radio.Group buttonStyle="solid" disabled={!editMode}>
                      <Radio.Button value="THIRD_PARTY">Third Party Freight</Radio.Button>
                      <Radio.Button value="OWN_VEHICLE">Own Fleet Vehicle</Radio.Button>
                      <Radio.Button value="COURIER">Courier / AWB</Radio.Button>
                      <Radio.Button value="IN_PERSON">In-Person Handover</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                </Col>

                <Col span={8}>
                  <Form.Item name="dispatch_date" label="Dispatch Date" rules={[{ required: true }]}>
                    <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} disabled={!editMode} />
                  </Form.Item>
                </Col>
                {dispatchType !== 'THIRD_PARTY' && (
                  <Col span={8}>
                    <Form.Item name="expected_delivery_date" label="Expected Delivery Date" rules={[{ required: true, message: 'Please select expected delivery date' }]}>
                      <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} disabled={!editMode} />
                    </Form.Item>
                  </Col>
                )}
                <Col span={8}>
                  <Form.Item name="status" label="Status" rules={[{ required: true }]}>
                    <Select disabled={!editMode}>
                      <Select.Option value="Draft">Draft</Select.Option>
                      <Select.Option value="Dispatched">Dispatched</Select.Option>
                      <Select.Option value="Delivered">Delivered</Select.Option>
                      <Select.Option value="Cancelled">Cancelled</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="destination_type" label="Destination Recipient Type" rules={[{ required: true }]}>
                    <Select disabled={!editMode}>
                      <Select.Option value="WAREHOUSE">Warehouse Transfer</Select.Option>
                      <Select.Option value="USER">Field User / Employee</Select.Option>
                      <Select.Option value="BRANCH">Internal Branch Office</Select.Option>
                      <Select.Option value="DEALER">Dealer / Distributor</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
                {destinationType === 'WAREHOUSE' && (
                  <Col span={8}>
                    <Form.Item name="destination_warehouse_id" label="Destination Warehouse" rules={[{ required: true, message: 'Please select destination warehouse' }]}>
                      <Select
                        placeholder="Choose recipient warehouse"
                        options={warehouses}
                        disabled={!editMode}
                        showSearch
                        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                      />
                    </Form.Item>
                  </Col>
                )}
                {destinationType === 'USER' && (
                  <Col span={8}>
                    <Form.Item name="destination_user_id" label="Destination SCM Field User" rules={[{ required: true, message: 'Please select recipient user' }]}>
                      <Select
                        placeholder="Choose recipient SCM user"
                        options={usersLookup}
                        disabled={!editMode}
                        showSearch
                        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                      />
                    </Form.Item>
                  </Col>
                )}
                <Col span={24}>
                  <Form.Item name="remarks" label="Remarks">
                    <TextArea rows={2} disabled={!editMode} placeholder="Enter delivery instructions or gate pass references..." />
                  </Form.Item>
                </Col>

                {dispatchMode === 'multi-level' && (
                  <Col span={24} style={{ marginTop: '16px' }}>
                    <Card 
                      title={<span style={{ fontWeight: 600 }}>Custody Handover Chain</span>}
                      size="small"
                      loading={loadingChain}
                      style={{ background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}
                    >
                      {custodyChain.length === 0 ? (
                        <div style={{ color: '#8c8c8c', padding: '16px', textAlign: 'center' }}>
                          No custody chain defined for this project/destination.
                        </div>
                      ) : (
                        <div style={{ padding: '16px 8px' }}>
                          <Steps
                            direction="vertical"
                            current={custodyChain.findIndex(c => c.status === 'pending')}
                            items={custodyChain.map((step, idx) => {
                              let status = 'wait';
                              let color = '#8c8c8c';
                              
                              if (step.status === 'acknowledged') {
                                status = 'finish';
                                color = '#16a34a';
                              } else if (step.status === 'pending') {
                                const firstPending = custodyChain.find(c => c.status === 'pending');
                                if (firstPending && firstPending.sequence === step.sequence) {
                                  status = 'process';
                                  color = '#1d4ed8';
                                } else {
                                  status = 'wait';
                                  color = '#6b7280';
                                }
                              } else if (step.status === 'skipped') {
                                status = 'wait';
                              }

                              return {
                                title: <span style={{ fontWeight: 600, color: color }}>{step.role_name || step.position_name}</span>,
                                description: (
                                  <div style={{ marginTop: 4 }}>
                                    <div style={{ fontWeight: 500, color: '#1e293b' }}>{step.employee_name}</div>
                                    {step.status === 'acknowledged' && (
                                      <div style={{ fontSize: '12px', color: '#64748b', marginTop: 4, background: '#fff', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                                        <div><strong>Seal Intact:</strong> {step.seal_intact ? 'Yes' : 'No'}</div>
                                        <div><strong>Condition:</strong> <Tag color={step.packaging_condition === 'INTACT' ? 'green' : 'orange'}>{step.packaging_condition}</Tag></div>
                                        <div><strong>Discrepancy:</strong> {step.discrepancy_reported ? <Tag color="red">Yes</Tag> : 'No'}</div>
                                        {step.remarks && <div><strong>Remarks:</strong> {step.remarks}</div>}
                                        <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: 4 }}>
                                          Received by {step.acknowledged_by_name} on {formatDate(step.acknowledged_at)}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ),
                                status: status,
                              };
                            })}
                          />
                        </div>
                      )}
                    </Card>
                  </Col>
                )}

                {custodyChain.find(step => step.can_acknowledge) && !isNew && (
                  <Col span={24} style={{ marginTop: '16px' }}>
                    <div style={{
                      background: 'linear-gradient(135deg, #eff6ff, #dbeafe)',
                      border: '1px solid #bfdbfe',
                      borderRadius: '12px',
                      padding: '16px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                    }}>
                      <div>
                        <h4 style={{ margin: 0, color: '#1e3a8a', fontWeight: 600, fontSize: '15px' }}>
                          Pending Custody Acknowledgement
                        </h4>
                        <p style={{ margin: '4px 0 0 0', color: '#1e40af', fontSize: '13px' }}>
                          You occupy the active position/role <strong>{custodyChain.find(step => step.can_acknowledge)?.role_name}</strong> ({custodyChain.find(step => step.can_acknowledge)?.employee_name}) required to acknowledge custody receipt for this step.
                        </p>
                      </div>
                      <Button 
                        type="primary" 
                        icon={<CheckOutlined />} 
                        onClick={() => setCustodyModalOpen(true)}
                        style={{ background: '#1d4ed8', borderColor: '#1d4ed8', height: '40px', borderRadius: '8px', fontWeight: 600 }}
                      >
                        Acknowledge Custody
                      </Button>
                    </div>
                  </Col>
                )}
              </Row>
            </Form>
          </Card>
        </Col>
      </Row>

      <Modal
        title="Acknowledge Custody Handover"
        open={custodyModalOpen}
        onCancel={() => {
          setCustodyModalOpen(false);
          custodyForm.resetFields();
        }}
        onOk={async () => {
          try {
            const values = await custodyForm.validateFields();
            setCustodySubmitting(true);
            await api.post(`/warehouse/dispatch/${id}/acknowledge-custody`, values);
            message.success('Custody acknowledged successfully');
            setCustodyModalOpen(false);
            custodyForm.resetFields();
            fetchDispatch();
            fetchSavedCustodyChain();
          } catch (err) {
            message.error(getErrorMessage(err));
          } finally {
            setCustodySubmitting(false);
          }
        }}
        confirmLoading={custodySubmitting}
        okText="Acknowledge Receipt"
      >
        <Form form={custodyForm} layout="vertical" initialValues={{ seal_intact: true, packaging_condition: 'INTACT', discrepancy_reported: false }}>
          <Form.Item name="seal_intact" label="Is Transit Seal Intact?" valuePropName="checked" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value={true}>Yes</Radio>
              <Radio value={false}>No</Radio>
            </Radio.Group>
          </Form.Item>
          
          <Form.Item name="packaging_condition" label="Packaging Condition" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value="INTACT">Intact</Radio>
              <Radio value="DAMAGED">Damaged</Radio>
              <Radio value="TAMPERED">Tampered</Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item name="discrepancy_reported" label="Discrepancy Reported?" valuePropName="checked" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value={true}>Yes</Radio>
              <Radio value={false}>No</Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item name="remarks" label="Remarks / Verification Details">
            <TextArea rows={3} placeholder="Provide any details about vehicle inspection, cargo condition, etc." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default DispatchForm;